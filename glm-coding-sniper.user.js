  // ==UserScript==
  // @name         GLM Coding Plan Pro 自动抢购
  // @namespace    https://bigmodel.cn
  // @version      1.6.3
  // @description  每天10:00自动抢购GLM Coding Plan 套餐，拦截售罄+自动点击+错误恢复+弹窗保护+路由重挂载+套餐映射可视化防错
  // @author       songwj
  // @match        https://open.bigmodel.cn/*
  // @match        https://www.bigmodel.cn/*
  // @match        https://bigmodel.cn/*
  // @grant        none
  // @run-at       document-start
  // @updateURL    https://raw.githubusercontent.com/songwj521dmly/GLM-Coding-Plan/master/glm-coding-sniper.user.js
  // @downloadURL  https://raw.githubusercontent.com/songwj521dmly/GLM-Coding-Plan/master/glm-coding-sniper.user.js
  // ==/UserScript==

  (function () {
    'use strict';

    // ==================== 0. 限流页面早期退出 ====================
    // 在 rate-limit 页面上运行会触发 CSP 错误，直接跳回购买页
    if (window.location.pathname.includes('rate-limit') || window.location.href.includes('rate-limit.html')) {
      console.log('[GLM Sniper] 检测到限流页，跳回购买页...');
      setTimeout(() => window.location.replace('https://open.bigmodel.cn/glm-coding'), 1000);
      return;
    }

    // ==================== 配置 ====================
    const CONFIG = {
      // 套餐优先级列表，按顺序尝试；第一个为首选，后续为候补
      // 每项: { plan: 'lite'|'pro'|'max', billingPeriod: 'monthly'|'quarterly'|'yearly' }
      planPriority: [
        { plan: 'lite', billingPeriod: 'quarterly' },
        // { plan: 'lite', billingPeriod: 'quarterly' }, // 候补（取消注释以启用）
      ],
      // 抢购时间 (24小时制)
      targetHour: 10,
      targetMinute: 0,
      targetSecond: 0,
      // 提前多少毫秒开始点击 (补偿网络延迟) — 会被服务器时间校准自动修正
      advanceMs: 200,
      // 点击重试间隔(ms)
      retryInterval: 100,
      // 最大重试次数 (300次 * 100ms = 30秒)
      maxRetries: 300,
      // 是否自动刷新页面 (在9:59:50自动刷新一次以获取最新状态)
      autoRefresh: true,
      autoRefreshSecondsBefore: 10,
      // soldOut 拦截窗口：目标时刻后持续多久(ms) — 默认5分钟，避免长时间篡改响应
      interceptWindowAfter: 300000,
      // 倒计时更新间隔(ms) — 200ms 足够流畅，减少 CPU 占用
      countdownInterval: 200,
      // 手动 productId 映射（productIdInfo API 不返回价格，无法自动识别套餐时使用）
      // 格式: { lite: 'product-xxx', pro: 'product-xxx', max: 'product-xxx' }
      // 留空则由脚本自动从页面请求中捕获
      manualProductId: null,
    };

    // 当前正在尝试的套餐索引
    let _currentPlanIdx = 0;
    function currentPlan()   { return CONFIG.planPriority[_currentPlanIdx].plan; }
    function currentPeriod() { return CONFIG.planPriority[_currentPlanIdx].billingPeriod; }

    // ==================== 状态 ====================
    let state = {
      retryCount: 0,
      isRunning: false,
      orderCreated: false,
      modalVisible: false,  // 检测到弹窗（验证码/支付）后停止一切刷新
      preheated: false,     // TCP 预热是否已完成
      switchingPlan: false, // tryNextPlan 切换中，防止 setupAutoSnipeOnReady 并发触发
      timerId: null,
      countdownId: null,
    };

    const OVERLAY_ID = 'glm-sniper-overlay';
    const BOOT_CACHE_KEY = 'glm_sniper_last_boot';
    const runtime = {
      routeHooksInstalled: false,
      overlayWatcherInstalled: false,
      initFinished: false,
    };

    /**
     * 判断当前页面是否为 GLM Coding 抢购页。
     * @returns {boolean} 当前 URL 是否命中目标购买页。
     */
    function isTargetPage() {
      return /^\/glm-coding(?:\/)?$/i.test(window.location.pathname);
    }

    /**
     * 记录脚本启动阶段，便于排查“脚本未生效”与 SPA 路由丢失问题。
     * @param {string} stage 当前阶段名称。
     * @param {string} [extra] 额外诊断信息。
     * @returns {void}
     */
    function markBoot(stage, extra = '') {
      const message = `[BOOT] ${stage}${extra ? ` | ${extra}` : ''}`;
      console.log(`[GLM Sniper] ${message}`);
      try {
        sessionStorage.setItem(BOOT_CACHE_KEY, JSON.stringify({
          stage,
          extra,
          url: window.location.href,
          ts: Date.now(),
        }));
      } catch (e) {}
    }

    /**
     * 安全读取浏览器通知权限，避免部分环境下直接访问 Notification 报错。
     * @returns {NotificationPermission|'unsupported'} 当前通知权限状态。
     */
    function getNotificationPermissionSafe() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported';
        return Notification.permission;
      } catch (e) {
        return 'unsupported';
      }
    }

    /**
     * 安全请求浏览器通知权限。
     * @returns {Promise<NotificationPermission|'unsupported'>} 权限请求结果。
     */
    function requestNotificationPermissionSafe() {
      if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
      try {
        return Notification.requestPermission();
      } catch (e) {
        return Promise.resolve('unsupported');
      }
    }

    // ==================== 1. 拦截 JSON.parse，修改售罄状态 ====================
    // 只在 10:00 前1分钟内才拦截，避免非抢购时段产生无效订单

    // 服务器时间偏移量(ms)：正数=本地慢于服务器，需提前触发
    let _timeOffset = 0;

    function getNow() {
      return Date.now() + _timeOffset;
    }

    function isNearTargetTime() {
      const now = getNow();
      const target = new Date(now);
      target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
      const diff = target - now;
      // 前1分钟 到 后 interceptWindowAfter 的窗口期内才拦截
      return diff <= 60000 && diff >= -CONFIG.interceptWindowAfter;
    }

    // 实际抢购时间窗口（目标时刻含 advanceMs 提前量 到 后30分钟），不含1分钟预热期
    function isInPurchaseTime() {
      const now = getNow();
      const target = new Date(now);
      target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
      const diff = target - now;
      return diff <= CONFIG.advanceMs && diff >= -1800000;
    }

    let _confirmedSoldOut = false;

    function isInRushWindow() {
      // 目标时刻 到 后 interceptWindowAfter 的强制拦截窗口
      const now = getNow();
      const target = new Date(now);
      target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
      const elapsed = now - target;
      return elapsed >= 0 && elapsed < CONFIG.interceptWindowAfter;
    }

    function shouldInterceptSoldOut() {
      return isInRushWindow();
    }

    // 通过价格静默识别套餐名（不输出日志，用于 soldOut 检测）
    function getPlanFromPrice(price) {
      if (!price) return null;
      for (const [name, p] of Object.entries(PLAN_PRICE_MAP)) {
        if (price === p) return name;
      }
      for (const [name, [min, max]] of Object.entries(PLAN_PRICE_RANGES)) {
        if (price >= min && price <= max) return name;
      }
      return null;
    }

    // 本轮已确认售罄的套餐集合（key = plan_period），走完一圈全售罄才停
    const _soldOutInCycle = new Set();
    // 连续全售罄的圈数（防止单套餐一次波动就立即 confirmSoldOut）
    let _soldOutCycleCount = 0;
    const SOLD_OUT_CYCLES_REQUIRED = 3;
    // 防止同一 API 响应内多次触发切换
    let _planSwitchPending = false;

    // 切换到下一个候补套餐，循环尝试直到一整圈全售罄
    function tryNextPlan() {
      if (state.orderCreated) return false;
      // 互斥锁：统一在此处持有，使 probeSoldOutStatus / deepModifySoldOut 均受约束，避免并发双跳
      if (_planSwitchPending) { log('[候补] 切换进行中，跳过重复触发'); return false; }
      _planSwitchPending = true;
      try {
        // 标记当前套餐本轮已售罄
        _soldOutInCycle.add(currentPlan() + '_' + currentPeriod());

        const prev = CONFIG.planPriority[_currentPlanIdx];
        _currentPlanIdx++;

        if (_currentPlanIdx >= CONFIG.planPriority.length) {
          // 走完一圈：检查是否全部售罄
          if (_soldOutInCycle.size >= CONFIG.planPriority.length) {
            _soldOutCycleCount++;
            if (_soldOutCycleCount >= SOLD_OUT_CYCLES_REQUIRED) {
              log(`[候补] 所有套餐已连续 ${SOLD_OUT_CYCLES_REQUIRED} 圈售罄，停止抢购`);
              _planSwitchPending = false;
              confirmSoldOut();
              return false;
            }
            log(`[候补] 全圈售罄 (第 ${_soldOutCycleCount}/${SOLD_OUT_CYCLES_REQUIRED} 圈)，继续轮询...`);
          } else {
            // 本圈并非全部售罄（可能是波动），重置连续计数，重新从头开始
            _soldOutCycleCount = 0;
            log(`[候补] 轮询一圈未全售罄，重新从 ${CONFIG.planPriority[0].plan} 开始...`);
          }
          _currentPlanIdx = 0;
          _soldOutInCycle.clear();
        }

        const next = CONFIG.planPriority[_currentPlanIdx];
        const isSamePlan = prev.plan === next.plan && prev.billingPeriod === next.billingPeriod;
        if (isSamePlan) {
          log(`[候补] ${prev.plan}/${prev.billingPeriod} 售罄，继续轮询...`);
        } else {
          log(`[候补] ${prev.plan}/${prev.billingPeriod} 售罄 → 切换到 ${next.plan}/${next.billingPeriod}`);
          notify('GLM 候补切换', `${prev.plan} 已售罄，正在尝试 ${next.plan}`);
        }
        clearCapturedProductId('retryReset');
        getProductId();
        updateTargetDisplay();
        setStatus(`候补: ${next.plan.toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[next.billingPeriod]||'包季'}`, '#ffaa00');
        if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
        state.switchingPlan = true; // Fix 6: 防止 setupAutoSnipeOnReady 并发触发
        state.isRunning = false;
        state.retryCount = 0;      // Fix 2: 重置重试计数，候补套餐获得完整的重试次数
        setTimeout(() => {
          _planSwitchPending = false;  // 解除互斥锁，允许下一次候补切换
          state.switchingPlan = false; // 无论是否立即触发，都要解除锁定
          if (isInPurchaseTime()) {    // 只在目标时间到达后才直接重启（避免提前60秒误触发）
            state.isRunning = true;
            startSnipe();
          }
          // 未到时间时由倒计时 / setupAutoSnipeOnReady 在目标时刻正常触发
        }, 200);
        return true;
      } catch (e) {
        _planSwitchPending = false;
        log(`[候补] 切换异常: ${e.message}`);
        return false;
      }
    }

    // 更新 overlay 中的套餐显示
    function updateTargetDisplay() {
      const el = document.getElementById('glm-target');
      if (!el) return;
      const periodLabel = {monthly:'包月', quarterly:'包季', yearly:'包年'}[currentPeriod()] || '包季';
      el.textContent = `目标: ${currentPlan().toUpperCase()} / ${periodLabel}`;
      updateResolvedProductDisplay();
    }

    // 主动探测一次服务端 soldOut 状态，直接解析不依赖拦截链
    async function probeSoldOutStatus() {
      if (state.orderCreated || _confirmedSoldOut) return;
      log('[探测] 主动同步服务端 soldOut 状态...');
      const probeHeaders = { 'Content-Type': 'application/json;charset=UTF-8', 'accept': 'application/json, text/plain, */*' };
      if (_capturedAuthHeader) probeHeaders['Authorization'] = _capturedAuthHeader;
      // 优先用新的 productIdInfo API，失败则降级到 batch-preview
      const apiUrls = [
        location.origin + '/api/biz/tokenResPack/productIdInfo',
        location.origin + '/api/biz/pay/batch-preview',
      ];
      for (const apiUrl of apiUrls) {
        try {
          const method = apiUrl.includes('productIdInfo') ? 'GET' : 'POST';
          const body = method === 'POST' ? '{}' : undefined;
          const resp = await originalFetch(apiUrl, {
            method,
            credentials: 'include',
            headers: probeHeaders,
            body,
          });
          if (!resp.ok) { continue; }
          const data = originalParse(await resp.text());
          // 新 API 格式: { data: { acSuccess: "product-005", ... } } — 无 soldOut 字段
          // 旧 API 格式: { data: { productList: [...] } } — 有 soldOut 字段
          const productList = data?.data?.productList || data?.productList || [];
          if (productList.length > 0) {
            log(`[探测] productList 共 ${productList.length} 条: ${productList.map(i => `${i?.monthlyOriginalAmount}/${i?.soldOut ?? i?.isSoldOut}`).join(', ')}`);
            const configuredKeys = CONFIG.planPriority.map(p => `${p.plan}_${p.billingPeriod}`);
            const soldOutMap = {};
            for (const item of productList) {
              if (!item) continue;
              const info = identifyPlanFromProduct(item);
              if (!info) continue;
              const key = `${info.plan}_${info.period}`;
              if (!configuredKeys.includes(key) || key in soldOutMap) continue;
              soldOutMap[key] = item.soldOut === true || item.isSoldOut === true;
            }
            const currentKey = `${currentPlan()}_${currentPeriod()}`;
            const allSoldOut = configuredKeys.length > 0 && configuredKeys.every(k => soldOutMap[k] === true);
            const currentPlanSoldOut = soldOutMap[currentKey];
            if (allSoldOut) {
              log(`[探测] 所有已配置套餐均售罄 (${configuredKeys.join(', ')})，停止抢购`);
              confirmSoldOut();
            } else if (currentPlanSoldOut === true) {
              log(`[探测] 服务端确认 ${currentKey} 售罄，停止抢购`);
              confirmSoldOut();
            } else if (currentPlanSoldOut === false) {
              log(`[探测] 服务端确认 ${currentKey} 有货，继续抢购`);
            } else {
              log(`[探测] 未找到当前套餐 ${currentKey} 的数据，忽略`);
            }
            return;
          }
          // 新 API 格式: 仅返回 productId 映射，无 soldOut 信息
          const hasProductIds = data?.data && typeof data.data === 'object' && Object.values(data.data).some(v => typeof v === 'string' && v.startsWith('product-'));
          if (hasProductIds) {
            log(`[探测] 新 API 仅返回 productId 映射，无 soldOut 数据，继续抢购`);
            return;
          }
        } catch (e) { log(`[探测] ${apiUrl} 异常: ${e.message}`); }
      }
    }

    // 在 9:55 主动获取并缓存 productId（高峰期 API 返回 555，必须提前获取）
    function schedulePrefetchProductId() {
      if (_capturedProductId) return; // 已有缓存，无需预获取
      const now = new Date();
      const prefetch = new Date(now);
      prefetch.setHours(CONFIG.targetHour, CONFIG.targetMinute - 5, 0, 0); // 9:55:00
      const ms = prefetch - now;

      const doPrefetch = () => {
        if (_capturedProductId) return;
        log('[预获取] 开始每 10s 获取 productId，直到成功或 9:59:50 刷新...');
        let attempt = 0;
        const timer = setInterval(async () => {
          if (_capturedProductId) { clearInterval(timer); return; }
          // 9:59:40 停止（自动刷新会在 9:59:50 重载页面，不必再发请求）
          const now = new Date();
          const stopAt = new Date(now);
          stopAt.setHours(CONFIG.targetHour, CONFIG.targetMinute - 1, 40, 0);
          if (now >= stopAt) { clearInterval(timer); return; }
          log(`[预获取] 第 ${++attempt} 次尝试...`);
          await fetchProductIdDirectly();
        }, 10000);
        // 立即执行第一次，不等 10s
        fetchProductIdDirectly();
      };

      if (ms <= 0) {
        // 已过 9:55（如用户 9:58 才打开页面）：立即预获取
        doPrefetch();
      } else {
        setTimeout(doPrefetch, ms);
        log(`[预获取] 将在 ${Math.round(ms / 1000)}s 后（9:55）获取 productId`);
      }
    }

    function scheduleWindowEnd() {
      const now = getNow();
      const end = new Date(now);
      end.setTime(end.getTime() + CONFIG.interceptWindowAfter);
      const ms = end - Date.now(); // 用真实本地时间计算 setTimeout 延迟

      const onWindowEnd = () => {
        const min = Math.round(CONFIG.interceptWindowAfter / 60000 * 10) / 10;
        log(`[${min}分] 强制拦截窗口结束，改为同步服务端 soldOut 状态`);
        if (!state.orderCreated) probeSoldOutStatus();
      };

      if (ms <= 0) {
        // 已过窗口期（如下午打开页面）：立即探测，由服务端决定是否售罄
        onWindowEnd();
        return;
      }
      setTimeout(onWindowEnd, ms);
    }

    function confirmSoldOut() {
      if (_confirmedSoldOut) return;
      _confirmedSoldOut = true;
      log('已确认售罄，停止抢购');
      setStatus('已售罄，明日再抢', '#ff4444');
      // 停止所有正在运行的抢购逻辑
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
      state.isRunning = false;
      state.switchingPlan = false; // 防止切换途中被 confirmSoldOut 锁死 setupAutoSnipeOnReady
      notify('GLM 抢购失败', '今日已售罄，明天 10:00 再来！');
      // 同步 DOM：将购买按钮还原为禁用状态，与服务端数据一致
      disablePurchaseButtons();
    }

    function disablePurchaseButtons() {
      const keywords = ['购买', '订阅', '订购', '立即购买', '立即订阅', '特惠订阅', 'Subscribe', 'Buy', 'Purchase'];
      document.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]').forEach((btn) => {
        if (btn.closest('#glm-sniper-overlay')) return; // 不影响脚本自身的按钮
        const text = (btn.textContent || '').trim();
        if (keywords.some((kw) => text.includes(kw))) {
          btn.disabled = true;
          btn.setAttribute('disabled', 'disabled');
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.5';
        }
      });
      log('[DOM] 已禁用购买按钮，与服务端售罄状态同步');
    }

    function notify(title, body) {
      try {
        if (getNotificationPermissionSafe() === 'granted') {
          new Notification(title, { body, icon: 'https://open.bigmodel.cn/favicon.ico' });
        }
      } catch (e) {}
    }

    const originalParse = JSON.parse;
    JSON.parse = function (...args) {
      let result = originalParse.apply(this, args);
      try {
        // 始终捕获 productId（不受时间窗口限制，页面加载时就捕获）
        if (!_capturedProductId) {
          captureProductIdFromData(result);
        }
        // soldOut 拦截只在抢购窗口期内
        if (isNearTargetTime()) {
          result = deepModifySoldOut(result);
        }
      } catch (e) {
        // 静默失败，不影响页面正常功能
      }
      return result;
    };

    // 伪装拦截后的 JSON.parse，防止被检测
    Object.defineProperty(JSON.parse, 'toString', {
      value: () => 'function parse() { [native code] }',
    });

    // 从 batch-preview 响应中按价格+折扣识别目标套餐的 productId
    // API 返回的 productList 没有 name 字段，只能通过价格区分套餐:
    //   Lite: monthlyOriginalAmount=49, Pro: =149, Max: =469
    // 计费周期通过 campaignDiscountDetails 区分:
    //   monthly: 无折扣, quarterly: "包季", yearly: "包年"
    let _allProductIds = {}; // { 'lite_monthly': productId, ... }
    let _productInfoCandidates = {}; // productinfo API 返回的平铺 key→productId 候选表
    let _capturedAuthHeader = null; // 从页面请求中捕获的 Authorization 头

    const PLAN_PRICE_MAP = { lite: 49, pro: 149, max: 469 };
    // 价格范围兜底：当 monthlyOriginalAmount 为折后价时精确匹配会失败，用范围兜底
    // 三档之间差距足够大，范围不会重叠，即使打折也安全
    const PLAN_PRICE_RANGES = { lite: [30, 80], pro: [100, 200], max: [350, 550] };

    // 周期关键词表：覆盖常见中文表达，防止平台文案微调导致识别失败
    const PERIOD_PATTERNS = {
      quarterly: ['包季', '季度', '季卡', '3个月', '三个月'],
      yearly:    ['包年', '年度', '年卡', '12个月', '一年'],
    };

    // 静默识别套餐计费周期（不输出日志，专供 deepModifySoldOut 热路径使用）
    function getPeriodFromItem(item) {
      const campaigns = item?.campaignDiscountDetails || [];
      for (const c of campaigns) {
        const cn = c.campaignName || '';
        for (const [p, patterns] of Object.entries(PERIOD_PATTERNS)) {
          if (patterns.some(kw => cn.includes(kw))) return p;
        }
      }
      return 'monthly';
    }

    function identifyPlanFromProduct(item) {
      const price = item.monthlyOriginalAmount;
      let plan = null;
      for (const [name, p] of Object.entries(PLAN_PRICE_MAP)) {
        if (price === p) { plan = name; break; }
      }
      if (!plan) {
        // 精确匹配失败（可能是折后价），用范围兜底
        for (const [name, [min, max]] of Object.entries(PLAN_PRICE_RANGES)) {
          if (price >= min && price <= max) { plan = name; break; }
        }
        if (plan) {
          log(`[识别] 价格 ${price} 精确匹配失败，范围兜底 → ${plan}（原价可能已变，建议更新 PLAN_PRICE_MAP）`);
        } else {
          log(`[识别失败] 未知价格: ${price}, productId=${item.productId} — 超出所有已知范围，请更新 PLAN_PRICE_MAP/PLAN_PRICE_RANGES`);
          return null;
        }
      }

      let period = 'monthly';
      let matchedCampaign = '';
      const campaigns = item.campaignDiscountDetails || [];
      outer: for (const c of campaigns) {
        const cn = c.campaignName || '';
        for (const [p, patterns] of Object.entries(PERIOD_PATTERNS)) {
          if (patterns.some(kw => cn.includes(kw))) {
            period = p;
            matchedCampaign = cn;
            break outer;
          }
        }
      }

      log(`[识别] 价格=${price} → ${plan} | campaignName="${matchedCampaign}" → ${period} | productId=${item.productId}`);
      return { plan, period };
    }

    // productIdInfo API 返回平铺 key→productId 结构时的智能匹配
    // 新 API (productIdInfo) keys: acSuccess, HAI, newUserPurchase, CCFold, Geekbang, Dify, CCFnew, register 等
    // 旧 API (productinfo) keys: 可能包含套餐关键词
    function getProductIdFromCandidates() {
      if (!Object.keys(_productInfoCandidates).length) return null;
      const plan = currentPlan();
      const period = currentPeriod();
      // 促销/非套餐 key 黑名单
      const promoKeys = ['newUserPurchase', 'CCFold', 'newUser', 'fold', 'promo', 'trial', 'Geekbang', 'Dify', 'register'];
      const entries = Object.entries(_productInfoCandidates);
      // 1. 精确关键词匹配（key 包含套餐名或周期名）
      for (const [k, pid] of entries) {
        const kl = k.toLowerCase();
        if ((kl.includes(plan) || kl.includes(period)) && !promoKeys.some(p => kl.toLowerCase().includes(p.toLowerCase()))) {
          log(`[候选] key="${k}" 命中套餐关键词 → productId=${pid}`);
          return pid;
        }
      }
      // 2. 过滤促销 key 后，若剩余唯一一个直接使用
      const filtered = entries.filter(([k]) => !promoKeys.some(p => k.toLowerCase().includes(p.toLowerCase())));
      if (filtered.length === 1) {
        log(`[候选] 唯一非促销候选: ${filtered[0][0]}→${filtered[0][1]}`);
        return filtered[0][1];
      }
      // 3. 新 API 格式: keys 不含套餐名，输出警告引导手动配置
      if (filtered.length > 1) {
        log(`[候选] 新 API 有 ${filtered.length} 个候选: [${filtered.map(([k,v])=>`${k}→${v}`).join(', ')}]`);
        log('[候选] 无法自动识别套餐对应的 productId，请在 CONFIG.manualProductId 中手动配置');
        log('[候选] 配置示例: manualProductId: { lite: "product-005", pro: "product-XXX", max: "product-XXX" }');
        // 不盲目回退，返回 null 等手动配置
        return null;
      }
      // 4. 全是促销 key 时取第一个（兜底）
      if (entries.length > 0) {
        log(`[候选] 仅有促销类候选，兜底使用第一个: ${entries[0][0]}→${entries[0][1]}`);
        return entries[0][1];
      }
      return null;
    }

    function captureProductIdFromData(obj) {
      if (!obj || typeof obj !== 'object') return;

      // 检测 batch-preview 响应结构: { data: { productList: [...] } }
      if (obj.productList && Array.isArray(obj.productList)) {
        // 未命中 PLAN_PRICE_MAP 时，输出全部价格集合辅助诊断
        const unknownPrices = obj.productList
          .filter(item => item && !Object.values(PLAN_PRICE_MAP).includes(item.monthlyOriginalAmount))
          .map(item => item.monthlyOriginalAmount);
        if (unknownPrices.length > 0) {
          log(`[诊断] productList 中存在未知价格: [${unknownPrices.join(', ')}] — 若套餐调价请更新 PLAN_PRICE_MAP`);
        }

        for (const item of obj.productList) {
          if (!item || !item.productId) continue;
          const info = identifyPlanFromProduct(item);
          if (!info) continue;
          const key = `${info.plan}_${info.period}`;
          _allProductIds[key] = item.productId;
          if (info.plan === currentPlan() && info.period === currentPeriod()) {
            setCapturedProductId(item.productId, {
              plan: info.plan,
              period: info.period,
              source: 'batchPreview',
            });
            // 持久化到 localStorage，刷新后立即可用，无需等 API 响应
            try {
              localStorage.setItem('glm_sniper_pid', JSON.stringify({
                id: item.productId, plan: info.plan,
                period: info.period, source: 'batchPreview', ts: Date.now(),
              }));
            } catch (e) {}
          }
        }
        if (Object.keys(_allProductIds).length > 0 && !_capturedProductId) {
          log(`[捕获] 找到${Object.keys(_allProductIds).length}个产品，但未匹配目标套餐 ${currentPlan()}/${currentPeriod()}`);
          log(`[诊断] 已捕获套餐: [${Object.keys(_allProductIds).join(', ')}]`);
        }
        return;
      }

      // 检测 productinfo API 的平铺 key→productId 结构: { acSuccess:"product-xxx", HAI:"product-xxx", ... }
      // productId 格式: "product-" 后跟字母数字
      const pidPattern = /^product-[a-z0-9]+$/i;
      const flatPidEntries = Object.entries(obj).filter(([, v]) => typeof v === 'string' && pidPattern.test(v));
      if (flatPidEntries.length >= 2) { // 至少2个才认为是 productinfo 结构（避免误匹配）
        let newCandidates = false;
        for (const [k, pid] of flatPidEntries) {
          if (!_productInfoCandidates[k]) { _productInfoCandidates[k] = pid; newCandidates = true; }
        }
        if (newCandidates) {
          log(`[productinfo] 捕获候选表: ${flatPidEntries.map(([k,v])=>`${k}→${v}`).join(', ')}`);
          // 若 _capturedProductId 仍为空，立即尝试匹配
          if (!_capturedProductId) {
            const pid = getProductIdFromCandidates();
            if (pid) {
              setCapturedProductId(pid, {
                plan: currentPlan(),
                period: currentPeriod(),
                source: 'productinfo',
              });
              log(`[productinfo] 已设定 productId=${pid}（来自候选表）`);
              try {
                localStorage.setItem('glm_sniper_pid', JSON.stringify({
                  id: pid, plan: currentPlan(), period: currentPeriod(), source: 'productinfo', ts: Date.now(),
                }));
              } catch (e) {}
            }
          }
        }
        return;
      }

      // 递归搜索嵌套的 data 字段
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (item && typeof item === 'object') captureProductIdFromData(item);
        }
      } else {
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') captureProductIdFromData(v);
        }
      }
    }

    // 获取 productId（含备选列表回退）
    function getProductId() {
      if (_capturedProductId) return _capturedProductId;
      // 手动配置优先
      if (CONFIG.manualProductId && CONFIG.manualProductId[currentPlan()]) {
        setCapturedProductId(CONFIG.manualProductId[currentPlan()], {
          plan: currentPlan(),
          period: currentPeriod(),
          source: 'manual',
        });
        log(`[手动] 使用配置的 productId=${_capturedProductId} (${currentPlan()})`);
        return _capturedProductId;
      }
      // 精确匹配
      const exactKey = `${currentPlan()}_${currentPeriod()}`;
      if (_allProductIds[exactKey]) {
        setCapturedProductId(_allProductIds[exactKey], {
          plan: currentPlan(),
          period: currentPeriod(),
          source: 'fallbackExact',
        });
        log(`[回退] 精确匹配 productId=${_capturedProductId} (${exactKey})`);
        return _capturedProductId;
      }
      // 同套餐不同周期
      for (const [key, pid] of Object.entries(_allProductIds)) {
        if (key.startsWith(currentPlan() + '_')) {
          setCapturedProductId(pid, {
            plan: currentPlan(),
            period: key.split('_')[1] || currentPeriod(),
            source: 'fallbackSamePlan',
          });
          log(`[回退] 同套餐匹配 productId=${pid} (${key})`);
          return pid;
        }
      }
      // 任意回退已移除：防止静默下错套餐。若无精确匹配或同套餐匹配，返回 null 并警告。
      if (Object.keys(_allProductIds).length > 0) {
        log(`[警告] 已捕获产品但无法匹配 ${currentPlan()}/${currentPeriod()}，拒绝回退`);
      }
      // productinfo 候选表回退
      const candidate = getProductIdFromCandidates();
      if (candidate) {
        setCapturedProductId(candidate, {
          plan: currentPlan(),
          period: currentPeriod(),
          source: 'fallbackCandidate',
        });
        log(`[回退] 从 productinfo 候选表获取 productId=${candidate}`);
        return _capturedProductId;
      }
      // localStorage 兜底：读取上次捕获的值（12小时内有效）
      try {
        const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
        if (saved && saved.id && saved.plan === currentPlan() &&
            saved.period === currentPeriod() && Date.now() - saved.ts < 43200000) {
          setCapturedProductId(saved.id, {
            plan: saved.plan,
            period: saved.period,
            source: saved.source || 'localStorage',
          });
          log(`[回退] 从 localStorage 恢复 productId=${saved.id}`);
          return _capturedProductId;
        }
      } catch (e) {}
      return null;
    }

    function deepModifySoldOut(obj) {
      if (obj === null || typeof obj !== 'object') return obj;

      if (Array.isArray(obj)) {
        return obj.map(deepModifySoldOut);
      }

      for (const key of Object.keys(obj)) {
        if (
          key === 'isSoldOut' ||
          key === 'soldOut' ||
          key === 'is_sold_out' ||
          key === 'sold_out'
        ) {
          if (obj[key] === true) {
            if (shouldInterceptSoldOut()) {
              obj[key] = false;
              log(`[拦截] 将 ${key} 从 true 改为 false`);
            } else {
              // 窗口外：soldOut=true 原样透传 Vue；若是当前目标套餐则切换候补
              const price = obj.monthlyOriginalAmount;
              const planName = price != null ? getPlanFromPrice(price) : null;
              if (price == null) {
                // Fix 4: 无价格字段，无法识别套餐，静默跳过（避免误切换）
              } else if (!planName) {
                log(`[候补] 检测到 soldOut=true，但价格 ${price} 超出已知范围，无法识别套餐（请更新 PLAN_PRICE_MAP）`);
              // 只在目标时间后才触发候补切换（10:00前 soldOut=true 是"未开放"状态，不代表真正售罄）
              } else if (isInPurchaseTime() && planName === currentPlan() && getPeriodFromItem(obj) === currentPeriod() && !_planSwitchPending) {
                // tryNextPlan 内部持有锁；此处检查 _planSwitchPending 仅为减少无效调度
                setTimeout(tryNextPlan, 100);
              }
            }
          }
        }
        if (key === 'isServerBusy' && obj[key] === true) {
          obj[key] = false;
          log('[拦截] 将 isServerBusy 从 true 改为 false');
        }
        // 递归处理嵌套对象
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          obj[key] = deepModifySoldOut(obj[key]);
        }
      }
      return obj;
    }

    // ==================== 2. 拦截 fetch + XHR (自动重试 + soldOut修改) ====================

    // 捕获的 productId (从 JSON.parse / API 响应 / 请求中提取)
    let _capturedProductId = null;
    let _capturedProductMeta = { plan: null, period: null, source: 'pending', ts: 0 };

    /**
     * 格式化套餐名与周期，便于在悬浮窗中直观展示。
     * @param {string|null} plan 套餐名。
     * @param {string|null} period 计费周期。
     * @returns {string} 可读文本。
     */
    function formatPlanPeriod(plan, period) {
      const planLabel = plan ? plan.toUpperCase() : '未识别';
      const periodLabel = { monthly: '包月', quarterly: '包季', yearly: '包年' }[period] || '周期未知';
      return `${planLabel} / ${periodLabel}`;
    }

    /**
     * 将内部 productId 来源转换为用户可读文本。
     * @param {string} source 内部来源标识。
     * @returns {string} 中文来源说明。
     */
    function getProductSourceLabel(source) {
      const sourceMap = {
        pending: '等待识别',
        batchPreview: '接口识别',
        productinfo: '候选表匹配',
        manual: '手动配置',
        fallbackExact: '精确回退',
        fallbackSamePlan: '同套餐回退',
        fallbackCandidate: '候选回退',
        localStorage: '本地缓存',
        fetchCapture: '页面请求',
        xhrCapture: '页面请求(XHR)',
        fetchInject: '自动补参',
        xhrInject: '自动补参(XHR)',
        retryReset: '等待重新识别',
      };
      return sourceMap[source] || source || '未知来源';
    }

    /**
     * 将已识别的 productId 与其元信息写入内存，并刷新悬浮窗展示。
     * @param {string|null} pid 商品 ID。
     * @param {{plan?: string|null, period?: string|null, source?: string}} [meta] 附加元信息。
     * @returns {string|null} 当前写入后的 productId。
     */
    function setCapturedProductId(pid, meta = {}) {
      _capturedProductId = pid || null;
      _capturedProductMeta = {
        plan: meta.plan ?? _capturedProductMeta.plan ?? null,
        period: meta.period ?? _capturedProductMeta.period ?? null,
        source: meta.source || _capturedProductMeta.source || 'pending',
        ts: Date.now(),
      };
      updateResolvedProductDisplay();
      return _capturedProductId;
    }

    /**
     * 清空当前锁定的 productId，避免候补切换后误用旧套餐编号。
     * @param {string} [source='retryReset'] 清空原因。
     * @returns {void}
     */
    function clearCapturedProductId(source = 'retryReset') {
      _capturedProductId = null;
      _capturedProductMeta = { plan: null, period: null, source, ts: Date.now() };
      updateResolvedProductDisplay();
    }

    /**
     * 同步悬浮窗中的 productId 信息，减少用户对当前锁定套餐的疑问。
     * @returns {void}
     */
    function updateResolvedProductDisplay() {
      const productEl = document.getElementById('glm-product');
      const noteEl = document.getElementById('glm-product-note');
      if (!productEl || !noteEl) return;

      if (!_capturedProductId) {
        productEl.textContent = '锁定商品: 未锁定';
        productEl.style.color = '#ffcc00';
        noteEl.textContent = `等待识别 ${formatPlanPeriod(currentPlan(), currentPeriod())} 的 productId`;
        noteEl.style.color = '#888';
        return;
      }

      const resolvedPlan = _capturedProductMeta.plan || currentPlan();
      const resolvedPeriod = _capturedProductMeta.period || currentPeriod();
      const matched = resolvedPlan === currentPlan() && resolvedPeriod === currentPeriod();
      const sourceLabel = getProductSourceLabel(_capturedProductMeta.source);
      productEl.textContent = `锁定商品: ${formatPlanPeriod(resolvedPlan, resolvedPeriod)}`;
      productEl.style.color = matched ? '#00ff88' : '#ff8800';
      noteEl.textContent = `productId=${_capturedProductId} | 来源: ${sourceLabel} | ${matched ? '已匹配当前目标' : '与当前目标不一致，请勿付款'}`;
      noteEl.style.color = matched ? '#aaa' : '#ff6666';
    }

    // --- 2a. fetch 拦截 ---
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      // 请求指纹随机化 — 每次请求看起来不一样，降低被识别为脚本的概率
      if (isNearTargetTime() && args[1]) {
        const headers = new Headers(args[1].headers);
        headers.set('X-Request-Id', Math.random().toString(36).slice(2, 15));
        headers.set('X-Timestamp', String(Date.now()));
        const q = (0.5 + Math.random() * 0.5).toFixed(1);
        headers.set('Accept-Language', `zh-CN,zh;q=${q},en;q=${(q * 0.7).toFixed(1)}`);
        args[1] = { ...args[1], headers };
      }

      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      // 捕获页面发出的 Authorization 头（页面 Axios 拦截器自动注入，脚本直接发请求时需要带上）
      if (!_capturedAuthHeader && args[1]?.headers) {
        try {
          const h = new Headers(args[1].headers);
          const auth = h.get('Authorization') || h.get('authorization');
          if (auth) { _capturedAuthHeader = auth; }
        } catch (e) {}
      }

      // preview 请求: 捕获 productId + 注入缺失的 productId
      if (/preview/i.test(url) && args[1]?.body) {
        try {
          let body = args[1].body;
          let bodyObj = typeof body === 'string' ? JSON.parse(body) : null;
          if (bodyObj) {
            if (bodyObj.productId) {
              if (!_capturedProductId) {
                // 首次捕获：暂存请求中的 productId
                setCapturedProductId(bodyObj.productId, {
                  plan: currentPlan(),
                  period: currentPeriod(),
                  source: 'fetchCapture',
                });
                log(`[捕获] productId=${_capturedProductId}`);
              } else if (bodyObj.productId !== _capturedProductId && !_forcePayDialogCalled && !state.orderCreated) {
                // 页面发出了不同的 productId（用户点击了不同套餐的按钮）
                // 信任页面的选择，更新 _capturedProductId 为新的值
                log(`[更新] productId 变更: ${_capturedProductId} → ${bodyObj.productId}（页面选择了不同套餐）`);
                setCapturedProductId(bodyObj.productId, {
                  plan: currentPlan(),
                  period: currentPeriod(),
                  source: 'fetchCapture',
                });
              }
            } else if (!_forcePayDialogCalled && !state.orderCreated) {
              // 请求中没有 productId，尝试注入（先精确匹配，再 productinfo 候选）
              const hadCapturedPid = !!_capturedProductId;
              const pid = _capturedProductId || getProductIdFromCandidates();
              if (pid) {
                bodyObj.productId = pid;
                args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
                if (!hadCapturedPid) {
                  setCapturedProductId(pid, {
                    plan: currentPlan(),
                    period: currentPeriod(),
                    source: 'fetchInject',
                  });
                } else {
                  updateResolvedProductDisplay();
                }
                if (!hadCapturedPid) {
                  log(`[注入] 使用 productinfo 候选 productId=${pid}（请确认套餐是否正确）`);
                } else {
                  log(`[注入] 已补充 productId=${pid}`);
                }
              }
            }
          }
        } catch (e) {}
      }

      let response = await originalFetch.apply(this, args);

      // 抢购窗口内，失败请求自动重试
      if (isNearTargetTime() && [429, 500, 502, 503].includes(response.status)) {
        for (let retry = 1; retry <= 8; retry++) {
          console.log(`[GLM Sniper] fetch ${response.status}，重试${retry}: ${url}`);
          await new Promise(r => setTimeout(r, 300 * retry));
          try {
            response = await originalFetch.apply(this, args);
            if (response.ok) { console.log('[GLM Sniper] fetch 重试成功!'); break; }
          } catch (e) {}
        }
      }

      // 从 API 响应中捕获 productId（复用价格映射策略，与 JSON.parse 拦截保持一致）
      if (!_capturedProductId && /coding|plan|product|package|productIdInfo/i.test(url)) {
        try {
          const clone = response.clone();
          const parsed = await clone.json();
          captureProductIdFromData(parsed?.data || parsed);
        } catch (e) {}
      }

      // soldOut 拦截 (已确认售罄则跳过)
      if (!isNearTargetTime() || _confirmedSoldOut) return response;
      if (/coding|plan|order|subscribe|product|package/i.test(url)) {
        try {
          const text = await response.clone().text();
          if (!shouldInterceptSoldOut()) {
            return new Response(text, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
          const modified = text
            .replace(/"isSoldOut"\s*:\s*true/g, '"isSoldOut":false')
            .replace(/"soldOut"\s*:\s*true/g, '"soldOut":false')
            .replace(/"is_sold_out"\s*:\s*true/g, '"is_sold_out":false')
            .replace(/"sold_out"\s*:\s*true/g, '"sold_out":false');
          if (modified !== text) log('[拦截] 已修改 fetch 响应中的售罄状态');
          return new Response(modified, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (e) { return response; }
      }

      // productId 缺失检测: preview 请求返回 productId 不能为空时，自动恢复并重试
      if (/preview/i.test(url)) {
        try {
          const clone2 = response.clone();
          const text2 = await clone2.text();
          if (text2.includes('productId') && text2.includes('不能为空')) {
            log('[拦截] 检测到 productId 为空，尝试恢复...');
            ensureProductId();
            selectBillingPeriod();
          }
        } catch (e) {}
      }

      // check 校验: preview 请求成功时验证 bizId
      if (/preview/i.test(url)) {
        try {
          const clone = response.clone();
          const data = await clone.json();
          if (data?.code === 200 && data?.data?.bizId) {
            const valid = await checkBizId(data.data.bizId);
            if (!valid) {
              return new Response(JSON.stringify({code: -1, msg: 'bizId expired'}), {
                status: 200, headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        } catch (e) {}
      }

      return response;
    };

    // --- 2a-2. check 校验: 验证 bizId 有效性 ---
    async function checkBizId(bizId) {
      try {
        const checkUrl = `${location.origin}/api/biz/pay/check?bizId=${encodeURIComponent(bizId)}`;
        const resp = await originalFetch(checkUrl, { credentials: 'include' });
        const data = await resp.json();
        if (data && data.data === 'EXPIRE') {
          log(`[check] bizId=${bizId} 已过期`);
          return false;
        }
        log(`[check] bizId=${bizId} 校验通过`);
        return true;
      } catch (e) {
        log(`[check] 校验异常: ${e.message}`);
        return true; // 异常时放行
      }
    }

    // --- 2b. XMLHttpRequest 拦截 (覆盖不走 fetch 的请求) ---
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._sniperUrl = url;
      this._sniperMethod = method;
      this._sniperArgs = null;
      return _xhrOpen.call(this, method, url, ...rest);
    };

    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (!_capturedAuthHeader && /^authorization$/i.test(name) && value) {
        _capturedAuthHeader = value;
      }
      return _xhrSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const url = this._sniperUrl || '';

      // XHR preview 请求: 捕获 + 注入 productId
      if (/preview/i.test(url) && args[0]) {
        try {
          let bodyObj = typeof args[0] === 'string' ? JSON.parse(args[0]) : null;
          if (bodyObj) {
            if (bodyObj.productId) {
              if (!_capturedProductId) {
                setCapturedProductId(bodyObj.productId, {
                  plan: currentPlan(),
                  period: currentPeriod(),
                  source: 'xhrCapture',
                });
                log(`[捕获] productId=${_capturedProductId} (XHR)`);
              } else if (bodyObj.productId !== _capturedProductId && !_forcePayDialogCalled && !state.orderCreated) {
                // 页面发出了不同的 productId，信任页面的选择
                log(`[更新] productId 变更: ${_capturedProductId} → ${bodyObj.productId} (XHR)`);
                setCapturedProductId(bodyObj.productId, {
                  plan: currentPlan(),
                  period: currentPeriod(),
                  source: 'xhrCapture',
                });
              }
            } else if (!_forcePayDialogCalled && !state.orderCreated) {
              const hadCapturedPid = !!_capturedProductId;
              const pid = _capturedProductId || getProductIdFromCandidates();
              if (pid) {
                bodyObj.productId = pid;
                args[0] = JSON.stringify(bodyObj);
                if (!hadCapturedPid) {
                  setCapturedProductId(pid, {
                    plan: currentPlan(),
                    period: currentPeriod(),
                    source: 'xhrInject',
                  });
                } else {
                  updateResolvedProductDisplay();
                }
                if (!hadCapturedPid) {
                  log(`[注入] 使用 productinfo 候选 productId=${pid}（请确认套餐是否正确）(XHR)`);
                } else {
                  log(`[注入] 已补充 productId=${pid} (XHR)`);
                }
              }
            }
          }
        } catch (e) {}
      }

      this._sniperArgs = args;
      if (isNearTargetTime()) {
        this.addEventListener('load', function xhrRetryHandler() {
          if ([429, 500, 502, 503].includes(this.status)) {
            console.log(`[GLM Sniper] XHR ${this.status}，1s后重试: ${this._sniperUrl}`);
            const self = this;
            setTimeout(() => {
              _xhrOpen.call(self, self._sniperMethod, self._sniperUrl, true);
              _xhrSend.apply(self, self._sniperArgs || []);
            }, 1000);
          }
        });
      }
      return _xhrSend.apply(this, args);
    };

    const ABNORMAL_PURCHASE_MODAL_KEYWORDS = [
      '购买人数过多',
      '购买人数较多',
      '访问人数较多',
      '人数较多',
      '人数过多',
      '请刷新重试',
      '请稍后再试',
      '请稍后重试',
      '当前购买人数',
      '服务繁忙',
      '系统繁忙',
      '排队',
      '拥挤',
    ];

    let _abnormalModalRetryTimer = null;
    let _lastAbnormalModalAt = 0;

    /**
     * 判断模态框是否为“人数过多/服务繁忙”类异常购买弹窗。
     * @param {Element} modal 模态框元素。
     * @returns {boolean} 是否命中异常弹窗特征。
     */
    function isAbnormalPurchaseModal(modal) {
      if (!modal) return false;
      const text = modal.textContent || '';
      const hasBusyText = ABNORMAL_PURCHASE_MODAL_KEYWORDS.some((kw) => text.includes(kw));
      const looksLikePurchaseFlow = text.includes('购买') || text.includes('订阅') || text.includes('支付') || text.includes('付款');
      return hasBusyText && looksLikePurchaseFlow;
    }

    /**
     * 尝试关闭异常购买弹窗，优先走页面自带的关闭/确认按钮。
     * @param {Element} modal 模态框元素。
     * @returns {boolean} 是否执行了关闭动作。
     */
    function tryCloseAbnormalModal(modal) {
      if (!modal) return false;
      const closeSelectors = [
        'button[aria-label*="关闭"]',
        'button[title*="关闭"]',
        '[class*="close"]',
        '[class*="Close"]',
        '[aria-label="close"]',
      ];
      for (const selector of closeSelectors) {
        const el = modal.querySelector(selector);
        if (el) {
          el.click?.();
          el.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
      }

      const buttonKeywords = ['关闭', '取消', '知道了', '我知道了', '确定', '稍后再试'];
      const buttons = modal.querySelectorAll('button, a[role="button"], span');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (buttonKeywords.some((kw) => text.includes(kw))) {
          btn.click?.();
          btn.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
      }

      // 最后兜底：隐藏异常层，避免其持续遮挡抢购流程。
      modal.style.display = 'none';
      modal.style.pointerEvents = 'none';
      return true;
    }

    /**
     * 异常购买弹窗关闭后，重置状态并继续抢购。
     * @param {string} reason 触发重试的原因说明。
     * @returns {void}
     */
    function scheduleRetryAfterAbnormalModal(reason) {
      const now = Date.now();
      if (_abnormalModalRetryTimer || now - _lastAbnormalModalAt < 1500) return;
      _lastAbnormalModalAt = now;

      log(`[异常弹窗] ${reason}，准备关闭并继续抢购`);
      setStatus('异常弹窗已关闭，继续抢购...', '#ff8800');
      state.modalVisible = false;
      state.orderCreated = false;
      _lastModalType = null;

      _abnormalModalRetryTimer = setTimeout(() => {
        _abnormalModalRetryTimer = null;
        if (_confirmedSoldOut) return;
        if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
        state.isRunning = false;
        state.retryCount = 0;
        _forcePayDialogCalled = false;
        selectBillingPeriod();
        ensureProductId();
        if (isInPurchaseTime()) {
          state.isRunning = true;
          startSnipe();
        } else {
          setStatus('等待抢购时间...', '#aaa');
        }
      }, 800);
    }

    // --- 2c. 弹窗保护：检测验证码/支付弹窗，一旦出现则冻结所有刷新逻辑 ---
    function setupModalProtector() {
      if (!document.body) {
        setTimeout(setupModalProtector, 200);
        return;
      }

      new MutationObserver(() => {
        // 只检测真正的验证码/支付弹窗，避免误判普通页面元素
        const modals = document.querySelectorAll(
          '[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]'
        );
        let foundRealModal = false;
        for (const modal of modals) {
          if (modal.offsetParent === null || modal.offsetHeight < 30) continue;
          if (isAbnormalPurchaseModal(modal)) {
            const closed = tryCloseAbnormalModal(modal);
            if (closed) {
              scheduleRetryAfterAbnormalModal('检测到购买人数过多/服务繁忙弹窗');
            }
            continue;
          }
          // 必须包含验证码或支付相关内容才算真正的弹窗
          const text = modal.textContent || '';
          const isCaptcha = text.includes('验证') || text.includes('滑动') || text.includes('拖动') ||
                            modal.querySelector('[class*="captcha"],[class*="verify"],[class*="slider-"]');
          const isPayment = text.includes('扫码') || text.includes('支付') || text.includes('付款') ||
                            modal.querySelector('canvas, img[src*="qr"], img[src*="pay"]');
          if (isCaptcha || isPayment) {
            foundRealModal = true;
            if (!state.modalVisible) {
              state.modalVisible = true;
              _lastModalType = isCaptcha ? 'captcha' : 'payment';
              const type = isCaptcha ? '验证码' : '支付';
              console.log(`[GLM Sniper] 检测到${type}弹窗! 冻结刷新`);
              log(`检测到${type}弹窗，已冻结刷新`);
              setStatus('请完成验证码 / 扫码支付!', '#ffcc00');
              playAlert();
            }
            break;
          }
        }
        // 没有真正的弹窗了
        if (!foundRealModal && state.modalVisible) {
          state.modalVisible = false;
          const dismissedType = _lastModalType;
          _lastModalType = null;
          console.log('[GLM Sniper] 弹窗已消失，恢复正常');
          log('弹窗已消失，恢复自动抢购');
          // 验证码完成后重新选择计费周期，防止产品数据丢失导致 productId 为空
          setTimeout(() => {
            selectBillingPeriod();
            ensureProductId();
          }, 500);
          // 验证码弹窗关闭后，等4s检查支付弹窗是否出现；若未出现则重新触发购买流程
          if (dismissedType === 'captcha' && !state.orderCreated && isInPurchaseTime()) {
            if (_postCaptchaRetryTimer) clearTimeout(_postCaptchaRetryTimer);
            _postCaptchaRetryTimer = setTimeout(async () => {
              _postCaptchaRetryTimer = null;
              if (state.orderCreated || state.modalVisible || _confirmedSoldOut) return;
              // 第一步：先重新 fetch 正确的 productId（避免用错误候选再次提交）
              log('[验证码后] 支付弹窗未出现，先重新获取 productId...');
              setStatus('重新获取 productId...', '#ffcc00');
              clearCapturedProductId('retryReset'); // 清掉可能错误的候选值，强制重新匹配
              await fetchProductIdDirectly();
              // 等 1s，看页面是否自动刷新状态后弹出支付窗
              await new Promise(r => setTimeout(r, 1000));
              if (state.orderCreated || state.modalVisible || _confirmedSoldOut) return;
              if (!_capturedProductId) {
                log('[验证码后] productId 仍未获取到，放弃本轮自动重试（请手动点击购买）');
                setStatus('productId 未就绪，请手动重试', '#ff8800');
                return;
              }
              // 第二步：productId 已就绪，重新触发购买
              log('[验证码后] productId 就绪，重新触发购买...');
              setStatus('重新触发购买...', '#ffcc00');
              if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
              state.isRunning = false;
              state.retryCount = 0;
              _forcePayDialogCalled = false;
              state.isRunning = true;
              startSnipe();
            }, 4000);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }

    // --- 2d. 错误页面 DOM 抑制：检测到错误渲染时隐藏并触发重新加载数据 ---
    function setupErrorSuppressor() {
      if (!document.body) {
        setTimeout(setupErrorSuppressor, 200);
        return;
      }

      new MutationObserver(() => {
        if (!isNearTargetTime()) return;
        // 有弹窗时不做任何操作，保护验证码/支付弹窗
        if (state.modalVisible) return;

        const bodyText = document.body.textContent || '';
        if (!bodyText.includes('访问人数较多') && !bodyText.includes('请刷新重试') && !bodyText.includes('请稍后重试') && !bodyText.includes('人数较多') && !bodyText.includes('服务繁忙')) return;

        // 找到包含错误信息的容器并隐藏
        const errorNodes = document.querySelectorAll('div, section, p');
        for (const node of errorNodes) {
          const t = node.textContent || '';
          if ((t.includes('访问人数较多') || t.includes('人数较多') || t.includes('请刷新重试') || t.includes('请稍后重试')) && node.offsetHeight > 50) {
            node.style.display = 'none';
            console.log('[GLM Sniper] 隐藏错误页面，触发重新加载...');

            setTimeout(() => {
              const currentUrl = window.location.href;
              window.history.pushState(null, '', currentUrl);
              window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
            }, 500);

            setTimeout(() => {
              const hash = window.location.hash;
              window.location.hash = hash + '_retry';
              setTimeout(() => { window.location.hash = hash; }, 100);
            }, 1500);

            break;
          }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // ==================== 3. UI 覆盖层 ====================
    function createOverlay() {
      if (!isTargetPage()) {
        markBoot('overlay-skip', '当前页面不是 glm-coding');
        return;
      }
      // 等待 body 存在 (SPA 框架可能延迟创建)
      if (!document.body) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', createOverlay);
        } else {
          // body 还没出现，轮询等待
          setTimeout(createOverlay, 100);
        }
        return;
      }

      // 避免重复创建
      if (document.getElementById(OVERLAY_ID)) return;

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.innerHTML = `
        <div style="
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 999999;
          background: rgba(0, 0, 0, 0.85);
          color: #00ff88;
          padding: 16px 20px;
          border-radius: 12px;
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 14px;
          min-width: 280px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(0, 255, 136, 0.3);
        ">
          <div style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">
            GLM Coding Plan Sniper <span style="color:#888;font-size:11px">${typeof GM_info !== 'undefined' ? 'v' + GM_info.script.version : ''}</span>
          </div>
          <div id="glm-target" style="color: #ffcc00; margin-bottom: 4px;">
            目标: ${currentPlan().toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[currentPeriod()]||'包季'}
          </div>
          <div id="glm-product" style="color: #ffcc00; margin-bottom: 4px;">
            锁定商品: 未锁定
          </div>
          <div id="glm-product-note" style="color: #888; font-size: 11px; line-height: 1.4;">
            等待识别 ${formatPlanPeriod(currentPlan(), currentPeriod())} 的 productId
          </div>
          <div id="glm-countdown" style="font-size: 20px; margin: 8px 0; color: #fff;">
            --:--:--
          </div>
          <div id="glm-status" style="color: #aaa; font-size: 12px;">
            等待初始化...
          </div>
          <div style="color:#f44;font-size:12px;margin-top:6px;font-weight:bold;line-height:1.4;">
            ⚠ 如果订单没有显示需要支付的金额，请不要扫码付款！
          </div>
          <div style="margin-top:6px;">
            <button id="glm-notif-btn" type="button" style="
              background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
              color:#ccc;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;
            ">🔔 开启通知</button>
          </div>
          <div id="glm-boot" style="color:#666;font-size:10px;margin-top:6px;">
            页面: ${window.location.hostname}${window.location.pathname}
          </div>
          <div id="glm-log" style="
            margin-top: 8px;
            max-height: 120px;
            overflow-y: auto;
            font-size: 11px;
            color: #888;
            border-top: 1px solid rgba(255,255,255,0.1);
            padding-top: 8px;
          "></div>
        </div>
      `;
      document.body.appendChild(overlay);
      markBoot('overlay-mounted', '悬浮窗已挂载');
      updateResolvedProductDisplay();

      const notifBtn = document.getElementById('glm-notif-btn');
      if (notifBtn) {
        notifBtn.addEventListener('click', () => {
          if (getNotificationPermissionSafe() === 'granted') return;
          requestNotificationPermissionSafe().then((permission) => {
            const btn = document.getElementById('glm-notif-btn');
            if (!btn) return;
            btn.textContent = permission === 'granted' ? '🔔 通知已开启' :
              permission === 'unsupported' ? '🔕 当前环境不支持通知' : '🔕 通知被拒绝';
          });
        });
      }

      startCountdown();
    }

    /**
     * 确保悬浮窗始终存在，解决 SPA 路由切换或 DOM 重建后悬浮窗丢失问题。
     * @param {string} reason 触发重建的原因。
     * @returns {void}
     */
    function ensureOverlayMounted(reason) {
      if (!isTargetPage()) return;
      if (document.getElementById(OVERLAY_ID)) return;
      markBoot('overlay-remount', reason);
      createOverlay();
    }

    /**
     * 安装路由监听，兼容 pushState/replaceState/popstate/hashchange 场景。
     * @returns {void}
     */
    function installRouteHooks() {
      if (runtime.routeHooksInstalled) return;
      runtime.routeHooksInstalled = true;

      const hookHistory = (methodName) => {
        const originalMethod = history[methodName];
        if (typeof originalMethod !== 'function') return;
        history[methodName] = function (...args) {
          const result = originalMethod.apply(this, args);
          setTimeout(() => ensureOverlayMounted(`history.${methodName}`), 50);
          return result;
        };
      };

      hookHistory('pushState');
      hookHistory('replaceState');
      window.addEventListener('popstate', () => setTimeout(() => ensureOverlayMounted('popstate'), 50));
      window.addEventListener('hashchange', () => setTimeout(() => ensureOverlayMounted('hashchange'), 50));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          setTimeout(() => ensureOverlayMounted('visibilitychange'), 50);
        }
      });
      markBoot('route-hooks-installed');
    }

    /**
     * 安装悬浮窗保活监控，页面重绘或节点被删除时自动补挂。
     * @returns {void}
     */
    function installOverlayWatcher() {
      if (runtime.overlayWatcherInstalled) return;
      runtime.overlayWatcherInstalled = true;

      const startWatch = () => {
        if (!document.body) {
          setTimeout(startWatch, 100);
          return;
        }
        new MutationObserver(() => {
          ensureOverlayMounted('mutation-observer');
        }).observe(document.body, { childList: true, subtree: true });
      };

      startWatch();
      setInterval(() => {
        if (!document.hidden) ensureOverlayMounted('heartbeat');
      }, 2000);
      markBoot('overlay-watcher-installed');
    }

    function log(msg) {
      console.log(`[GLM Sniper] ${msg}`);
      const logEl = document.getElementById('glm-log');
      if (logEl) {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        logEl.innerHTML =
          `<div>${time} ${msg}</div>` + logEl.innerHTML;
        // 限制日志条数
        if (logEl.children.length > 20) {
          logEl.removeChild(logEl.lastChild);
        }
      }
    }

    function setStatus(msg, color = '#aaa') {
      const el = document.getElementById('glm-status');
      if (el) {
        el.textContent = msg;
        el.style.color = color;
      }
    }

    // ==================== 4. 倒计时 ====================
    function getTargetTime() {
      const now = getNow();
      const target = new Date(now);
      target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);

      // 如果今天已过目标时间，设为明天
      if (now >= target) {
        target.setDate(target.getDate() + 1);
      }
      return target;
    }

    function startCountdown() {
      if (state.countdownId) return;
      let _prewarmDone = false; // 防止多次预热

      const update = () => {
        const now = getNow();
        const target = getTargetTime();
        const diff = target - now;

        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        const ms = diff % 1000;

        const el = document.getElementById('glm-countdown');
        if (el) {
          // 正在抢购时段 (isRunning 或已到目标时刻) 不显示倒计时；已确认售罄则跳过
          if (!_confirmedSoldOut && (state.isRunning || isInPurchaseTime())) {
            el.textContent = '抢购中...';
            el.style.color = '#00ff88';
          } else if (diff <= 60000 && diff > 0) {
            // 最后60秒显示毫秒倒计时
            el.textContent = `${s}.${String(ms).padStart(3, '0')}s`;
            el.style.color = '#ff4444';
          } else {
            el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            el.style.color = diff <= 300000 ? '#ffcc00' : '#fff';
          }
        }

        // 自动刷新 (提前N秒)
        if (CONFIG.autoRefresh && !state.isRunning) {
          const refreshTime = CONFIG.autoRefreshSecondsBefore * 1000;
          if (diff <= refreshTime && diff > refreshTime - 1000) {
            log('自动刷新页面以获取最新状态...');
            setStatus('刷新中...', '#ffcc00');
            // 延迟一点再刷新，避免刷新太早
            location.reload();
            return;
          }
        }

        // 提前60秒预热：直接调API捕获 productId（不经过Vue数据流，不更新Vue soldOut状态）
        // 注意：不在此处调用 selectBillingPeriod()，避免9:59的响应把 soldOut=true 写入Vue state
        // 到10:00 selectBillingPeriod() + forceSoldOutFalse() 才让Vue得到 soldOut=false
        if (diff <= 60000 && diff > 0 && !_prewarmDone && !state.isRunning) {
          _prewarmDone = true;
          log('预热: 直接捕获 productId（不触发 Vue 状态更新）...');
          setStatus('准备中...', '#ffcc00');
          fetchProductIdDirectly();
        }

        // TCP 预热 (提前3-10秒建立连接池，扩大窗口避免JS繁忙时错过)
        if (diff <= 10000 && diff > 2000 && !state.preheated) {
          state.preheated = true;
          preheat();
        }

        // 到点开始抢购
        if (diff <= CONFIG.advanceMs && !state.isRunning) {
          state.isRunning = true;
          log(`开始抢购! (提前${CONFIG.advanceMs}ms)`);
          setStatus('正在抢购...', '#00ff88');
          startSnipe();
        }
      };

      state.countdownId = setInterval(update, CONFIG.countdownInterval);
      update();

      log('倒计时已启动');
      setStatus('等待抢购时间...', '#aaa');
    }

    // ==================== 4b. TCP 预热 ====================
    async function preheat() {
      // 只在目标站点执行，避免跨域 CSP 错误
      if (location.hostname !== 'open.bigmodel.cn') return;
      log('TCP 预热中...');
      try {
        // preconnect 由浏览器原生建立，比 fetch HEAD 更早、更高效
        ['https://open.bigmodel.cn'].forEach(origin => {
          const link = document.createElement('link');
          link.rel = 'preconnect';
          link.href = origin;
          document.head.appendChild(link);
        });
        // 保留一个 fetch HEAD 触发实际 HTTP 连接（preconnect 仅建立 TCP/TLS）
        originalFetch(location.origin + '/favicon.ico', { method: 'HEAD', cache: 'no-cache', credentials: 'include' }).catch(() => {});
        log('预热完成 (preconnect + fetch HEAD)');
      } catch (e) {
        log('预热失败，不影响使用');
      }
    }

    // ==================== 4c. 等待 productId 捕获 ====================
    // 若 batch-preview 响应还没回来，最多等 maxWaitMs 毫秒再继续
    function waitForProductId(maxWaitMs = 3000) {
      if (getProductId()) return Promise.resolve(true);
      return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (getProductId()) {
            clearInterval(timer);
            resolve(true);
          } else if (Date.now() - start >= maxWaitMs) {
            clearInterval(timer);
            resolve(false);
          }
        }, 100);
      });
    }

    // ==================== 4d. 主动获取 productId（降级策略）====================
    // waitForProductId 超时后的最后手段：直接调用产品列表 API
    async function fetchProductIdDirectly() {
      if (_capturedProductId) return true;
      if (!_capturedAuthHeader) {
        log('[主动获取] Authorization 头未就绪，跳过（等待页面初始化）');
        return false;
      }
      // 优先使用手动配置的 productId
      if (CONFIG.manualProductId && CONFIG.manualProductId[currentPlan()]) {
        setCapturedProductId(CONFIG.manualProductId[currentPlan()], {
          plan: currentPlan(),
          period: currentPeriod(),
          source: 'manual',
        });
        log(`[主动获取] 使用手动配置: ${currentPlan()}=${_capturedProductId}`);
        return true;
      }
      const authHeaders = {
        'Content-Type': 'application/json;charset=UTF-8',
        'accept': 'application/json, text/plain, */*',
        'Authorization': _capturedAuthHeader,
      };
      // 策略1: productIdInfo API（页面实际使用的端点）
      log('[主动获取] 尝试 productIdInfo API...');
      try {
        const resp = await originalFetch(location.origin + '/api/biz/tokenResPack/productIdInfo', {
          method: 'GET',
          credentials: 'include',
          headers: authHeaders,
        });
        if (resp.ok) {
          const data = await resp.json();
          captureProductIdFromData(data?.data || data);
          if (_capturedProductId) {
            log(`[主动获取] productIdInfo 成功: productId=${_capturedProductId}`);
            return true;
          }
          log('[主动获取] productIdInfo 返回了数据但无法匹配当前套餐，尝试其他API...');
        }
      } catch (e) { log(`[主动获取] productIdInfo 异常: ${e.message}`); }
      // 策略2: batch-preview API（旧的端点，可能仍在使用）
      log('[主动获取] 尝试 batch-preview API...');
      try {
        const resp2 = await originalFetch(location.origin + '/api/biz/pay/batch-preview', {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders,
          body: '{}',
        });
        if (resp2.ok) {
          const data2 = await resp2.json();
          captureProductIdFromData(data2?.data || data2);
          if (_capturedProductId) {
            log(`[主动获取] batch-preview 成功: productId=${_capturedProductId}`);
            return true;
          }
        }
      } catch (e) { log(`[主动获取] batch-preview 异常: ${e.message}`); }
      // 策略3: productinfo API（旧的端点）
      log('[主动获取] 尝试 productinfo API...');
      try {
        const resp3 = await originalFetch(location.origin + '/api/biz/pay/productinfo', {
          method: 'GET',
          credentials: 'include',
          headers: authHeaders,
        });
        if (resp3.ok) {
          const data3 = await resp3.json();
          captureProductIdFromData(data3?.data || data3);
          if (_capturedProductId) {
            log(`[主动获取] productinfo 成功: productId=${_capturedProductId}`);
            return true;
          }
        }
      } catch (e) { log(`[主动获取] productinfo 异常: ${e.message}`); }
      log('[主动获取] 所有 API 均未返回匹配的 productId — 请在抢购前手动设置 CONFIG.manualProductId');
      return false;
    }

    // ==================== 5. 核心抢购逻辑 ====================
    function selectBillingPeriod() {
      const periodKeywords = {
        monthly:   { match: '包月', exclude: ['包季', '包年'], label: '连续包月' },
        quarterly: { match: '包季', exclude: ['包月', '包年'], label: '连续包季' },
        yearly:    { match: '包年', exclude: ['包月', '包季'], label: '连续包年' },
      };
      const period = periodKeywords[currentPeriod()] || periodKeywords.quarterly;

      // 策略1: 精确匹配 Element UI 的 switch-tab-item 结构（页面实际使用）
      const switchTabs = document.querySelectorAll('.switch-tab-item, .switch-tab-item-content');
      for (const tab of switchTabs) {
        const text = (tab.textContent || '').trim();
        if (text.includes(period.match) && period.exclude.every(ex => !text.includes(ex))) {
          tab.click();
          tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          log('已选择: ' + period.label + ' (via switch-tab)');
          return true;
        }
      }

      // 策略2: 降级通用搜索 — 先定位目标套餐卡片
      const planKeywords = {
        lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
        pro:  ['pro', 'Pro', 'PRO', '专业', '进阶'],
        max:  ['max', 'Max', 'MAX', '旗舰', '高级'],
      };
      const targetPlanKeys = planKeywords[currentPlan()] || [];
      let searchRoot = document;
      for (const el of document.querySelectorAll('div, section, article, li')) {
        const text = el.textContent || '';
        if (targetPlanKeys.some(k => text.includes(k)) && el.offsetHeight < 800 && el.offsetWidth < 600) {
          searchRoot = el;
          break;
        }
      }

      const tabs = searchRoot.querySelectorAll('div, span, button, a, li, label');
      for (const tab of tabs) {
        const text = (tab.textContent || '').trim();
        if (text.includes(period.match) && period.exclude.every(ex => !text.includes(ex)) && text.length < 20) {
          tab.click();
          tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          log('已选择: ' + period.label);
          return true;
        }
      }
      log('未找到' + period.label + '选项，使用页面默认');
      return false;
    }

    async function startSnipe() {
      if (state.timerId) { log('[保护] timerId 已存在，跳过重复启动'); return; }
      _forcePayDialogCalled = false; // 新轮次重置，允许支付弹窗再次被触发
      state.switchingPlan = false; // Fix 6: 切换完成，解除锁定
      state.isRunning = true;      // 统一在此设置，防止调用方（tryNextPlan）漏设导致倒计时重复触发
      // 已确认售罄时不启动抢购
      if (_confirmedSoldOut) {
        log('已确认售罄，不启动抢购');
        setStatus('已售罄，明日再抢', '#ff4444');
        state.isRunning = false;
        return;
      }

      // 先选择计费周期（点击会触发 batch-preview API，进而捕获 productId）
      selectBillingPeriod();
      // 直接将 Vue 响应式 soldOut 状态强制置 false（应对预热缓存导致 Vue 仍持有 soldOut=true）
      forceSoldOutFalse();
      // 移除所有disabled属性
      removeAllDisabled();

      // 若 productId 尚未捕获，等待最多 3 秒
      if (!getProductId()) {
        log('productId 未就绪，等待 batch-preview 响应...');
        setStatus('等待 productId...', '#ffcc00');
        const got = await waitForProductId(3000);
        if (got) {
          log(`productId 已就绪: ${_capturedProductId}`);
          setStatus('productId 就绪，开始抢购...', '#00ff88');
        } else {
          // 降级：主动调用产品 API 获取
          log('主动获取 productId...');
          setStatus('主动获取 productId...', '#ffcc00');
          await fetchProductIdDirectly();
          // 无论是否成功，进入点击循环——循环内会检查 productId，未获取时跳过点击
        }
      }

      // 开始循环尝试点击
      let _waitingForPid = false; // 正在等待 productId 时只打一次日志
      state.timerId = setInterval(() => {
        // 运行中确认售罄 → 立即停止
        if (_confirmedSoldOut) {
          clearInterval(state.timerId);
          state.timerId = null;
          state.isRunning = false;
          log('已确认售罄，停止抢购');
          setStatus('已售罄，明日再抢', '#ff4444');
          return;
        }
        if (state.orderCreated) {
          clearInterval(state.timerId);
          return;
        }
        if (state.retryCount >= CONFIG.maxRetries) {
          clearInterval(state.timerId);
          // 重置状态，允许 setupAutoSnipeOnReady 重新触发
          state.isRunning = false;
          state.retryCount = 0;
          log('本轮重试结束，等待页面恢复后重新触发...');
          setStatus('等待页面恢复...', '#ffcc00');
          return;
        }

        // productId 未就绪：不点击购买按钮（避免触发验证码），等待后台获取
        if (!_capturedProductId) {
          if (!_waitingForPid) {
            _waitingForPid = true;
            log('productId 未就绪，暂停点击，等待后台获取...');
            setStatus('等待 productId...', '#ffcc00');
          }
          return; // 不消耗重试次数
        }
        _waitingForPid = false;

        state.retryCount++;
        if (state.retryCount % 10 === 1) {
          log(`第 ${state.retryCount} 次尝试...`);
        }

        // 移除disabled — 每5次循环执行一次，降低DOM开销
        if (state.retryCount % 5 === 1) {
          removeAllDisabled();
        }

        // 尝试查找并点击购买按钮
        const clicked = tryClickPurchaseButton();
        if (clicked) {
          log('已点击购买按钮!');
          setStatus('已点击购买按钮，等待响应...', '#00ff88');
        }

        // 尝试点击确认按钮 (如果弹出了确认对话框)
        tryClickConfirmButton();
      }, CONFIG.retryInterval);
    }

    function removeAllDisabled() {
      // 移除所有按钮的disabled属性
      document.querySelectorAll('button[disabled], a[disabled], input[disabled]').forEach((el) => {
        el.removeAttribute('disabled');
        el.disabled = false;
        el.classList.remove('disabled', 'is-disabled', 'btn-disabled');
        // 移除内联样式中的禁用
        if (el.style.pointerEvents === 'none') {
          el.style.pointerEvents = 'auto';
        }
        if (el.style.opacity === '0.5' || el.style.opacity === '0.6') {
          el.style.opacity = '1';
        }
      });

      // 处理通过 CSS class 禁用的元素
      document
        .querySelectorAll('.disabled, .is-disabled, .btn-disabled, .sold-out')
        .forEach((el) => {
          el.classList.remove('disabled', 'is-disabled', 'btn-disabled', 'sold-out');
          el.style.pointerEvents = 'auto';
          el.style.opacity = '1';
        });
    }

    function tryClickPurchaseButton() {
      // 策略1: 精确选择器 — button[name="特惠订阅"] (页面实际使用)
      const nameButtons = document.querySelectorAll('button[name="特惠订阅"]');
      if (nameButtons.length >= 3) {
        // 按钮顺序: 0=Lite, 1=Pro, 2=Max (与页面DOM顺序一致)
        const planIndex = { lite: 0, pro: 1, max: 2 }[currentPlan()];
        if (planIndex !== undefined && nameButtons[planIndex]) {
          const btn = nameButtons[planIndex];
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return true;
        }
      }

      // 策略2: class选择器 — .buy-btn (页面实际使用)
      const buyButtons = document.querySelectorAll('.buy-btn');
      if (buyButtons.length >= 3) {
        const planIndex = { lite: 0, pro: 1, max: 2 }[currentPlan()];
        if (planIndex !== undefined && buyButtons[planIndex]) {
          const btn = buyButtons[planIndex];
          const btnText = (btn.textContent || '').trim();
          if (btnText.includes('订阅') || btnText.includes('购买')) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return true;
          }
        }
      }

      // 策略3: 降级 — 通过文字内容查找按钮
      const keywords = ['特惠订阅', '特惠购买', '立即购买', '立即订阅', '立即订购', '购买', '订阅'];
      const planKeywords = {
        lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
        pro: ['pro', 'Pro', 'PRO', '专业', '进阶'],
        max: ['max', 'Max', 'MAX', '旗舰', '高级'],
      };

      const targetPlanKeys = planKeywords[currentPlan()] || [];

      // 先找到目标套餐区域
      let targetSection = null;
      const allElements = document.querySelectorAll('div, section, article, li');
      for (const el of allElements) {
        const text = el.textContent || '';
        if (targetPlanKeys.some((k) => text.includes(k))) {
          if (el.offsetHeight < 800 && el.offsetWidth < 600) {
            targetSection = el;
            break;
          }
        }
      }

      // 在目标区域内查找购买按钮
      const searchRoot = targetSection || document;
      const buttons = searchRoot.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]');

      for (const btn of buttons) {
        const btnText = (btn.textContent || '').trim();
        if (keywords.some((kw) => btnText.includes(kw))) {
          if (targetSection || hasNearbyPlanText(btn, targetPlanKeys)) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return true;
          }
        }
      }

      // 策略4: 直接通过data属性或id查找
      const specificSelectors = [
        `[data-plan="${currentPlan()}"]`,
        `[data-type="${currentPlan()}"]`,
        `#${currentPlan()}-buy-btn`,
        `#buy-${currentPlan()}`,
        `.${currentPlan()}-purchase`,
        `[data-plan-type="${currentPlan()}"]`,
      ];

      for (const selector of specificSelectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            el.click();
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          }
        } catch (e) {}
      }

      return false;
    }

    function hasNearbyPlanText(btn, planKeys) {
      // 向上查找3层父元素，看是否包含套餐标识
      let el = btn;
      for (let i = 0; i < 5; i++) {
        el = el.parentElement;
        if (!el) break;
        const text = el.textContent || '';
        if (planKeys.some((k) => text.includes(k))) {
          return true;
        }
      }
      return false;
    }

    function tryClickConfirmButton() {
      // 查找确认对话框中的按钮
      const confirmKeywords = ['已知悉', '继续订阅', '前往认证', '确认', '确定', '立即支付', '去支付', '提交订单', 'Confirm', 'OK', 'Submit'];

      // 查找模态框/对话框
      const modals = document.querySelectorAll(
        '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"], [role="dialog"]'
      );

      for (const modal of modals) {
        if (modal.offsetParent === null) continue; // 不可见的跳过

        const buttons = modal.querySelectorAll('button, a[role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim();
          // 跳过取消类按钮
          if (/取消|暂不订阅|Cancel/i.test(text)) continue;
          if (confirmKeywords.some((kw) => text.includes(kw))) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            log(`点击确认按钮: "${text}"`);
            if (text.includes('认证')) {
              setStatus('请完成实名认证...', '#ffcc00');
            } else {
              setStatus('已点击确认，等待支付弹窗...', '#ffcc00');
            }
            // 不在此处设 orderCreated=true，等实际支付弹窗/QR 出现后再设
            // 延迟检查支付弹窗是否弹出，没有则直接操作 Vue
            setTimeout(forcePayDialog, 2000);
            return true;
          }
        }
      }

      return false;
    }

    // ==================== 6. 监控DOM变化，及时响应 ====================
    function setupMutationObserver() {
      if (!document.body) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', setupMutationObserver);
        } else {
          setTimeout(setupMutationObserver, 100);
        }
        return;
      }

      const observer = new MutationObserver((mutations) => {
        // 只在抢购启动后才检测二维码，避免误判页面已有的文字
        if (!state.isRunning) return;

        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              // 必须是新弹出的模态框/弹窗内的内容，且包含canvas或qr图片
              const hasQR = node.querySelector?.('canvas, img[src*="qr"], img[src*="pay"]');
              const isModal = node.matches?.('[class*="modal"], [class*="dialog"], [role="dialog"]') ||
                              node.closest?.('[class*="modal"], [class*="dialog"], [role="dialog"]');
              const text = node.textContent || '';
              const hasPayText = text.includes('扫码') || text.includes('支付宝') || text.includes('微信支付');
              const abnormalModal = isModal ? (node.matches?.('[class*="modal"], [class*="dialog"], [role="dialog"]') ? node : node.closest?.('[class*="modal"], [class*="dialog"], [role="dialog"]')) : null;

              if (abnormalModal && isAbnormalPurchaseModal(abnormalModal)) {
                log('检测到异常购买弹窗，尝试关闭并继续抢购');
                tryCloseAbnormalModal(abnormalModal);
                state.orderCreated = false;
                if (state.timerId) {
                  clearInterval(state.timerId);
                  state.timerId = null;
                }
                scheduleRetryAfterAbnormalModal('检测到异常购买弹窗');
                continue;
              }

              if (hasQR) {
                // 真正检测到二维码图像才通知
                log('检测到支付二维码!');
                setStatus('支付二维码已出现! 快扫码!', '#00ff88');
                state.orderCreated = true;
                if (_postCaptchaRetryTimer) { clearTimeout(_postCaptchaRetryTimer); _postCaptchaRetryTimer = null; }
                clearInterval(state.timerId);
                state.timerId = null;
                playAlert();
                notify('GLM 抢购成功！', '支付二维码已出现，快去扫码！');
                setTimeout(forcePayDialog, 1500);
              } else if (isModal && hasPayText) {
                // 支付弹窗出现但 QR 尚未加载，先停止点击，等 QR
                log('检测到支付弹窗（QR 尚未加载）');
                setStatus('支付弹窗已出现，等待二维码...', '#ffcc00');
                state.orderCreated = true; // 停止重复点击购买按钮
                if (_postCaptchaRetryTimer) { clearTimeout(_postCaptchaRetryTimer); _postCaptchaRetryTimer = null; }
                clearInterval(state.timerId);
                state.timerId = null;
              }
            }
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      log('DOM 监控已启动');
    }

    function playAlert() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        // 播放3次"嘟"声
        [0, 300, 600].forEach((delay) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 880;
          gain.gain.value = 0.3;
          osc.start(ctx.currentTime + delay / 1000);
          osc.stop(ctx.currentTime + delay / 1000 + 0.15);
        });
      } catch (e) {
        // 音频播放失败不影响功能
      }
    }

    // ==================== 7. 时间校准 (使用服务器时间) ====================
    async function calibrateTime() {
      // 只在目标站点执行，避免跨域 CSP 错误
      if (location.hostname !== 'open.bigmodel.cn') return;
      try {
        const res = await originalFetch(location.origin + '/', {
          method: 'HEAD',
          cache: 'no-cache',
        });
        const serverDate = res.headers.get('date');
        if (serverDate) {
          const serverTime = new Date(serverDate);
          const localTime = new Date();
          const offset = serverTime - localTime;
          _timeOffset = offset; // 存储偏移量，所有时间判断自动应用
          log(`时间偏差: ${offset}ms (${offset > 0 ? '本地慢' : '本地快'})，已自动校准`);
          if (Math.abs(offset) > 1000) {
            log(`警告: 本地时间偏差较大 (${offset}ms)，建议校准系统时间`);
            setStatus(`时间校准: ${offset > 0 ? '+' : ''}${offset}ms`, '#ffcc00');
          } else {
            setStatus(`时间已校准 (${offset > 0 ? '+' : ''}${offset}ms)`, '#aaa');
          }
          // 动态调整 advanceMs：本地快则多提前，本地慢则少提前
          CONFIG.advanceMs = Math.max(0, Math.min(500, CONFIG.advanceMs + offset));
          log(`动态 advanceMs: ${CONFIG.advanceMs}ms`);
        }
      } catch (e) {
        log('时间校准失败，使用本地时间');
      }
    }

    // ==================== 8. 页面加载失败自动恢复 ====================
    let _refreshCount = 0;

    function setupAutoRetryRefresh() {
      function checkAndRecover() {
        // 抢购时间窗口内才尝试恢复（与 isNearTargetTime 保持一致）
        if (!isNearTargetTime()) return;
        // 有弹窗时绝不刷新（保护验证码/支付弹窗）
        if (state.modalVisible) return;

        const bodyText = document.body?.textContent || '';
        const errorKeywords = ['访问人数较多', '人数较多', '请刷新重试', '请稍后再试', '请稍后重试', '服务繁忙', '网络错误', '加载失败'];
        const isError = errorKeywords.some(kw => bodyText.includes(kw));

        // 页面 HTML 都没加载出来（完全空白 / 502 / 503 纯文本）
        const pageBlank = document.body && document.body.children.length < 3 && bodyText.trim().length < 100;

        if (!isError && !pageBlank) {
          // 页面正常，重置计数器
          _refreshCount = 0;
          return;
        }

        _refreshCount++;
        console.log(`[GLM Sniper] 页面异常 (第${_refreshCount}次)，尝试恢复...`);

        // 限制刷新频率：至少间隔5秒
        const lastRefresh = parseInt(sessionStorage.getItem('glm_last_refresh') || '0');
        if (Date.now() - lastRefresh < 5000) return;
        sessionStorage.setItem('glm_last_refresh', String(Date.now()));

        // 如果当前在限流页 (rate-limit.html)，直接跳回购买页
        if (window.location.pathname.includes('rate-limit')) {
          console.log('[GLM Sniper] 检测到限流页，跳回购买页...');
          window.location.replace('https://open.bigmodel.cn/glm-coding');
          return;
        }

        // 正常页面异常：带 cache-busting 强刷
        const url = new URL(window.location.href);
        url.searchParams.set('_t', Date.now());
        window.location.replace(url.toString());
      }

      // 页面加载完后检查
      if (document.readyState === 'complete') {
        setTimeout(checkAndRecover, 1500);
      } else {
        window.addEventListener('load', () => setTimeout(checkAndRecover, 2000));
      }

      // 持续监控（每2秒检查一次）
      setInterval(checkAndRecover, 2000);
    }

    // ==================== 9. 页面恢复后自动触发抢购 ====================
    function setupAutoSnipeOnReady() {
      // 每2秒检测：如果已到目标时刻（含 advanceMs），页面正常，且还没开始抢购，就自动开始
      setInterval(() => {
        if (!isInPurchaseTime()) return;
        if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut || state.switchingPlan) return;

        // 检测页面是否有购买按钮（说明页面正常加载了）
        const bodyText = document.body?.textContent || '';
        const hasError = ['访问人数较多', '人数较多', '请刷新重试', '请稍后重试', '服务繁忙'].some(kw => bodyText.includes(kw));
        if (hasError) return;

        // 必须找到套餐专属的购买按钮（排除"即刻订阅"等通用 CTA），且按钮不含售罄字样
        const buyKeywords = ['特惠订阅', '特惠购买', '立即购买', '立即订购', '立即订阅'];
        const soldOutKeywords = ['售罄', '补货'];
        const hasBuyButton = Array.from(document.querySelectorAll('button')).some(btn => {
          if (btn.offsetParent === null) return false;
          const text = (btn.textContent || '').trim();
          if (soldOutKeywords.some(kw => text.includes(kw))) return false;
          return buyKeywords.some(kw => text.includes(kw));
        });
        if (!hasBuyButton) return;

        // 页面正常且有购买按钮，自动触发抢购
        log('页面恢复正常，自动触发抢购!');
        setStatus('页面恢复，正在抢购...', '#00ff88');
        state.isRunning = true;
        startSnipe();
      }, 2000);
    }

    // ==================== 10. Vue 组件直接操作 ====================

    // --- Vue 版本检测 + 统一 walker ---
    function getVueRoot() {
      const app = document.querySelector('#app');
      if (!app) return null;
      if (app.__vue__)              return { ver: 2, root: app.__vue__ };          // Vue 2
      if (app.__vue_app__?._instance) return { ver: 3, root: app.__vue_app__._instance }; // Vue 3
      return null;
    }

    // 统一遍历 Vue 2/3 组件树，对每个组件实例调用 fn(vm, ver)
    function walkVueTree(vm, ver, depth, fn) {
      if (!vm || depth > 10) return;
      fn(vm, ver);
      if (ver === 2) {
        for (const child of (vm.$children || [])) walkVueTree(child, 2, depth + 1, fn);
      } else {
        // Vue 3：通过 subTree vnode 找子组件实例
        const walkVNode = (vnode, d) => {
          if (!vnode || d > 12) return;
          if (vnode.component) walkVueTree(vnode.component, 3, d, fn);
          if (Array.isArray(vnode.children)) {
            vnode.children.forEach(c => c && typeof c === 'object' && walkVNode(c, d + 1));
          }
        };
        if (vm.subTree) walkVNode(vm.subTree, depth + 1);
      }
    }

    // 读取组件数据（Vue 2: $data；Vue 3: proxy 代理对象）
    function getVMData(vm, ver) {
      if (ver === 2) return vm.$data || {};
      return vm.proxy || {};
    }

    // 向组件写入属性
    function setVMProp(vm, ver, key, val) {
      try {
        if (ver === 2) vm[key] = val;
        else if (vm.proxy) vm.proxy[key] = val;
      } catch (e) {}
    }

    // 确保 Vue 组件中 productId 存在，防止验证码后数据丢失
    function ensureProductId() {
      const pid = getProductId();
      if (!pid) { log('[Vue] 没有捕获到 productId，无法恢复'); return; }

      const vr = getVueRoot();
      if (!vr) { log('[Vue] 未检测到 Vue 实例'); return; }

      let fixed = 0;
      // 第一遍：只修复空值字段
      walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
        const data = getVMData(vm, ver);
        for (const key of Object.keys(data)) {
          if (/product.?id/i.test(key) && !data[key]) {
            setVMProp(vm, ver, key, pid);
            fixed++;
            log(`[Vue${ver}] 已设置 ${key}=${pid}`);
          }
        }
      });

      if (fixed === 0) {
        log('[Vue] 未找到空的 productId 字段，尝试广搜...');
        // 第二遍：找到任意 productId 字段强制覆盖
        walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
          if (fixed > 0) return;
          const data = getVMData(vm, ver);
          for (const key of Object.keys(data)) {
            if (/product.?id/i.test(key)) {
              setVMProp(vm, ver, key, pid);
              fixed++;
              log(`[Vue${ver}] 强制设置 ${key}=${pid}`);
              return;
            }
          }
        });
      }
    }

    // 直接将 Vue 组件树中所有 soldOut 类响应式属性强制设为 false
    // 应对预热阶段 batch-preview 将 soldOut=true 写入 Vue state 导致 click handler 内部短路的问题
    function forceSoldOutFalse() {
      const vr = getVueRoot();
      if (!vr) return;
      let patched = 0;
      walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
        const data = getVMData(vm, ver);
        for (const key of Object.keys(data)) {
          if (/soldOut|isSoldOut|sold_out|is_sold_out/i.test(key) && data[key] === true) {
            setVMProp(vm, ver, key, false);
            patched++;
          }
        }
      });
      if (patched > 0) log(`[Vue] 强制 soldOut=false (${patched}个字段)`);
    }

    // Fix 5: 防止 forcePayDialog 在用户关闭弹窗后 1.5s 又重新打开
    let _forcePayDialogCalled = false;
    // 记录上一次弹窗类型（captcha / payment），用于弹窗消失后决定是否重试购买
    let _lastModalType = null;
    // 防止验证码后重试购买时重复触发
    let _postCaptchaRetryTimer = null;

    // 抢购成功后，如果支付弹窗没自动弹出，直接操作 Vue 组件
    function forcePayDialog() {
      if (_forcePayDialogCalled) return; // 只触发一次，避免重开已关弹窗
      _forcePayDialogCalled = true;

      const vr = getVueRoot();
      if (!vr) return;

      let payComp = null;
      walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
        if (payComp) return;
        const data = getVMData(vm, ver);
        if ('payDialogVisible' in data) payComp = { vm, ver };
      });

      if (!payComp) { log('[Vue] 未找到支付组件'); return; }
      const data = getVMData(payComp.vm, payComp.ver);
      if (data.payDialogVisible) { log('[Vue] 支付弹窗已显示'); return; }

      setVMProp(payComp.vm, payComp.ver, 'payDialogVisible', true);
      log(`[Vue${payComp.ver}] 已直接设置 payDialogVisible=true`);
    }

    // 定时 patch Vue 组件的 isServerBusy
    function patchVueServerBusy() {
      let attempts = 0;
      const tid = setInterval(() => {
        if (++attempts > 30) { clearInterval(tid); return; }
        const vr = getVueRoot();
        if (!vr) return;
        let patched = 0;
        // 支付弹窗已打开（有真实订单数据），不再清除 isServerBusy
        // 否则 555 响应后平台标记 isServerBusy=true，清除会导致弹窗显示 undefined
        if (_forcePayDialogCalled || state.orderCreated) { clearInterval(tid); return; }
        walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
          const data = getVMData(vm, ver);
          if (data.isServerBusy === true) {
            setVMProp(vm, ver, 'isServerBusy', false);
            patched++;
          }
        });
        if (patched > 0) {
          log(`[Vue] 已解除 isServerBusy (${patched}个组件)`);
          clearInterval(tid);
        }
      }, 500);
    }

    // ==================== 11. 启动 ====================
    function init() {
      if (runtime.initFinished) {
        ensureOverlayMounted('init-reentry');
        return;
      }
      markBoot('init-start');
      installRouteHooks();
      installOverlayWatcher();

      // 启动错误恢复
      setupAutoRetryRefresh(); // 全页面级别的强刷兜底
      setupErrorSuppressor(); // DOM级别的错误抑制 + SPA路由重试
      setupModalProtector(); // 弹窗保护（验证码/支付）

      createOverlay();
      setupMutationObserver();
      setupAutoSnipeOnReady();   // 页面恢复后自动触发抢购

      // 通知权限：不自动请求（避免被浏览器静默拒绝），由用户点击悬浮窗按钮触发
      // 已授权时更新按钮文字
      if (getNotificationPermissionSafe() === 'granted') {
        setTimeout(() => {
          const btn = document.getElementById('glm-notif-btn');
          if (btn) btn.textContent = '🔔 通知已开启';
        }, 500);
      }

      // 从 localStorage 预加载上次捕获的 productId（刷新后立即可用）
      try {
        const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
        if (saved && saved.id && saved.plan === currentPlan() &&
            saved.period === currentPeriod() && Date.now() - saved.ts < 43200000) {
          setCapturedProductId(saved.id, {
            plan: saved.plan,
            period: saved.period,
            source: saved.source || 'localStorage',
          });
          log(`[localStorage] 预加载 productId=${saved.id}`);
        }
      } catch (e) {}

      // 强制拦截窗口结束时（10:02）改为同步服务端 soldOut 状态
      scheduleWindowEnd();

      // 9:55 预获取 productId：高峰期 batch-preview 返回 555，必须提前缓存
      schedulePrefetchProductId();

      // 延迟校准时间 + patch Vue isServerBusy + 定期捕获 productId
      setTimeout(calibrateTime, 2000);
      patchVueServerBusy();
      // 定期检查 productId 是否已捕获（直到成功）
      // 每 3s 检查内存/localStorage；每 15s 额外发一次主动 fetch（防止高峰期 API 不可用）
      let _pidFetchTick = 0;
      const pidTimer = setInterval(() => {
        if (_capturedProductId) { clearInterval(pidTimer); return; }
        if (getProductId()) { clearInterval(pidTimer); return; }
        if (++_pidFetchTick % 2 === 0) fetchProductIdDirectly(); // 每 2 次 = 6s 发一次主动请求
      }, 3000);

      const planList = CONFIG.planPriority.map((p, i) => `${i === 0 ? '首选' : '候补' + i}: ${p.plan}/${p.billingPeriod}`).join('，');
      log(`脚本已启动 - ${planList}`);
      log(`抢购时间: 每天 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2, '0')}:${String(CONFIG.targetSecond).padStart(2, '0')}`);
      log('提前10秒自动刷新，到点自动抢购');
      log('页面加载失败会自动强刷');
      log('检测到验证码/支付弹窗会冻结刷新');
      runtime.initFinished = true;
      markBoot('init-finished');

      // 如果当前已经是抢购时间窗口内（刚好打开页面），立即开始
      if (isInPurchaseTime()) {
        // 延迟2秒等待 API 数据加载，以便售罄检测生效
        setTimeout(() => {
          if (_confirmedSoldOut) {
            log('已确认售罄，不启动抢购');
            setStatus('已售罄，明日再抢', '#ff4444');
            return;
          }
          log('当前正是抢购时间! 立即开始!');
          state.isRunning = true;
          startSnipe();
        }, 2000);
      }
    }

    /* 调试用：暴露内部状态到 window（控制台可用 __glmSniper.xxx 访问）
    window.__glmSniper = {
      get state() { return state; },
      get confirmedSoldOut() { return _confirmedSoldOut; },
      get cycleCount() { return _soldOutCycleCount; },
      get soldOutInCycle() { return [..._soldOutInCycle]; },
      get planIdx() { return _currentPlanIdx; },
      probe() { return probeSoldOutStatus(); },
      reset() {
        _confirmedSoldOut = false;
        _soldOutCycleCount = 0;
        _soldOutInCycle.clear();
        _planSwitchPending = false;
        _currentPlanIdx = 0;
        _forcePayDialogCalled = false;
        if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
        state.isRunning = false;
        state.switchingPlan = false;
        log('[Debug] 状态已重置');
      }
    };
    */

    try {
      init();
    } catch (error) {
      markBoot('init-error', error && error.message ? error.message : String(error));
      console.error('[GLM Sniper] 初始化失败:', error);
    }
  })();
