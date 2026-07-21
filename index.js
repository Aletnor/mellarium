// [MP] 蜜脾 Mellarium · 桥(bridge) — 无界面
// 职责：监听酒馆事件广播当前聊天状态；接收主页面(vault)指令并执行。
// 通信：BroadcastChannel('mellarium')，消息一律 {type, chatKey, payload}。
// 第1期只实现：chat-changed / chat-dirty 广播 + get-snapshot / ping 应答。

(function () {
    'use strict';

    const CHANNEL = 'mellarium';
    const TAG = '[MP-bridge]';

    const channel = new BroadcastChannel(CHANNEL);

    function ctx() {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext()
            : null;
    }

    // [MP] chatKey = 角色名/聊天文件名（群聊暂不支持，返回 group/ 前缀以示区分）
    function currentChatKey() {
        const c = ctx();
        if (!c) return null;
        const chatId = c.getCurrentChatId ? c.getCurrentChatId() : null;
        if (!chatId) return null;
        if (c.groupId) return `group:${c.groupId}/${chatId}`;
        const charName = (c.characters && c.characters[c.characterId] && c.characters[c.characterId].name)
            || c.name2 || 'unknown';
        return `${charName}/${chatId}`;
    }

    function send(type, payload) {
        channel.postMessage({ type, chatKey: currentChatKey(), payload: payload ?? null });
    }

    // [MP] 快照：当前聊天全部消息的只读拷贝，桥不做任何加工
    function buildSnapshot() {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const messages = chat.map(function (m, i) {
            const hasSwipes = Array.isArray(m.swipes) && m.swipes.length > 0;
            const swipes = hasSwipes ? m.swipes.slice() : [m.mes != null ? m.mes : ''];
            let swipeId = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
            if (swipeId < 0 || swipeId >= swipes.length) swipeId = 0;
            return {
                floorIndex: i,
                name: m.name != null ? m.name : '',
                is_user: !!m.is_user,
                is_system: !!m.is_system,          // [MP] 隐藏标记
                mes: m.mes != null ? m.mes : '',    // 当前采用版本正文
                swipes: swipes,                     // 全部版本
                swipeId: swipeId,                   // 当前采用版本号
                sendDate: m.send_date != null ? m.send_date : null, // 指纹1
            };
        });
        return { chatKey: currentChatKey(), messages: messages, count: messages.length };
    }

    // [MP] 读取区间内当前采用版本原文（含user楼与#0楼，不过滤），拼接
    function collectRangeText(rangeStart, rangeEnd) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart > rangeEnd)
            throw new Error('区间非法: ' + rangeStart + '~' + rangeEnd);
        const parts = [];
        for (let i = rangeStart; i <= rangeEnd; i++) {
            const m = chat[i];
            if (!m) throw new Error('楼层 ' + i + ' 不存在');
            const who = m.is_user ? (c.name1 || 'User') : (m.name || 'AI');
            parts.push('【' + i + '楼·' + who + '】\n' + (m.mes != null ? m.mes : ''));
        }
        return parts.join('\n\n');
    }

    // [MP] 所有在飞的副API请求控制器；vault 刷新时发 cancel-inflight 一把掐光，杜绝「上次刷新前卡住的僵尸请求」。
    const inflight = new Set();

    // [MP] 副API请求 — 改走酒馆核心 ChatCompletionService（无状态裸 fetch，经后端同源代理绕 CORS）。
    // 换掉旧的 TavernHelper.generateRaw：那条带 CG/停止按钮/is_send_press 状态，第一发占住不还，
    // 第二发（连测试也算）死等状态释放→240秒超时。ChatCompletionService 一发一清、天生可重入。
    // key 走 openai 源的 reverse_proxy(地址)+proxy_password(钥匙)，可 per-call 带钥匙，无需存档密钥。
    async function callSubApi(apiConfig, systemPrompt, userText, opts) {
        opts = opts || {};
        const label = opts.label || '副API';
        // [MP] 桥侧超时：ChatCompletionService.sendRequest 对 signal=null 会兜一个「永不 abort 的新 signal」，
        //      挂起的 fetch 永远不回、连接不释放，堆成僵尸把后续请求也拖死。这里塞一个真能掐的 AbortController。
        //      成功的总结日志里最慢 52 秒，超过就是上游卡死了，掐掉自动换一发（retries 次）。
        const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 80000;
        const retries = Number(opts.retries) >= 0 ? Number(opts.retries) : 0;
        const c = ctx();
        const svc = c && c.ChatCompletionService;
        if (!svc || typeof svc.processRequest !== 'function')
            throw new Error('ChatCompletionService 不可用（酒馆版本过旧或上下文未就绪）');
        if (!apiConfig || !apiConfig.apiurl || !apiConfig.model)
            throw new Error('副API配置缺失（apiurl / model）');
        // [MP] 归一 base：去尾斜杠、去掉可能带上的 /chat/completions，reverse_proxy 只要到 /v1 这层
        let base = String(apiConfig.apiurl).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
        const messages = [
            { role: 'system', content: String(systemPrompt || '') },
            { role: 'user', content: String(userText || '') },
        ];
        const requestData = {
            chat_completion_source: 'openai',   // openai 源 + reverse_proxy 才能 per-call 带 key
            reverse_proxy: base,
            proxy_password: apiConfig.key || '',
            model: apiConfig.model,
            messages: messages,
            stream: false,
            max_tokens: Number(apiConfig.maxTokens) > 0 ? Number(apiConfig.maxTokens) : 8192,
        };

        // [MP] 单发：带真 AbortController + 超时；超时抛特制 TIMEOUT 标记让外层决定要不要重试
        async function attempt(attemptNo) {
            const controller = new AbortController();
            inflight.add(controller);
            let timedOut = false;
            const timer = setTimeout(function () { timedOut = true; try { controller.abort(); } catch (e) {} }, timeoutMs);
            const t0 = Date.now();
            const tag = label + (retries > 0 ? ' 第' + attemptNo + '发' : '');
            try { send('bridge-debug', { message: tag + ' 请求已发出（源文' + String(userText || '').length + '字，上限' + Math.round(timeoutMs / 1000) + '秒）' }); } catch (e) {}
            let res;
            try {
                res = await svc.processRequest(requestData, {}, true, controller.signal);
            } catch (e) {
                const dt = ((Date.now() - t0) / 1000).toFixed(1);
                if (timedOut || (e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message || ''))))) {
                    try { send('bridge-debug', { message: tag + ' 超时 ' + dt + '秒，已掐断连接' }); } catch (e2) {}
                    const te = new Error('TIMEOUT'); te._mpTimeout = true; throw te;
                }
                throw e;
            } finally {
                clearTimeout(timer);
                inflight.delete(controller);
            }
            let raw = '';
            if (typeof res === 'string') raw = res;
            else if (res && typeof res === 'object') raw = res.content || res.reasoning || '';
            try {
                send('bridge-debug', {
                    message: tag + ' 返回 耗时' + ((Date.now() - t0) / 1000).toFixed(1) + '秒 长度=' + (raw ? raw.length : 0)
                        + ' 预览=' + String(raw || '').slice(0, 160),
                });
            } catch (e) { /* 探针失败不致命 */ }
            return raw;
        }

        for (let i = 0; i <= retries; i++) {
            try {
                return await attempt(i + 1);
            } catch (e) {
                if (e && e._mpTimeout) {
                    if (i < retries) {
                        try { send('bridge-debug', { message: label + ' 第' + (i + 1) + '发卡死，自动换第' + (i + 2) + '发' }); } catch (e2) {}
                        continue;
                    }
                    throw new Error('副API连着' + (retries + 1) + '发都在' + Math.round(timeoutMs / 1000) + '秒内没回（上游卡死）。源文 ' + String(userText || '').length + ' 字，缩小区间或换快一点的模型再试。');
                }
                throw e;
            }
        }
    }

    // [MP] 照抄酒馆 ensureSwipes 逻辑（未在 getContext 暴露）：规整 swipes/swipe_id/swipe_info 三件套
    function ensureSwipesLocal(m) {
        if (!Array.isArray(m.swipes)) m.swipes = [m.mes != null ? m.mes : ''];
        if (typeof m.swipe_id !== 'number') m.swipe_id = 0;
        const mk = function () {
            return { send_date: m.send_date, gen_started: m.gen_started, gen_finished: m.gen_finished, extra: {} };
        };
        if (!Array.isArray(m.swipe_info)) m.swipe_info = m.swipes.map(mk);
        while (m.swipe_info.length < m.swipes.length) m.swipe_info.push(mk());
        // 把当前采用正文对齐进当前 swipe 槽，防止追加前丢掉手改内容
        if (m.swipe_id >= 0 && m.swipe_id < m.swipes.length) m.swipes[m.swipe_id] = m.mes != null ? m.mes : '';
    }

    // [MP] ===== 注入（第3期）=====
    // 把「信息档案 + 最新一卷总结」合成一段，用 setExtensionPrompt 注入。
    // 单键保证顺序固定（档案在前、总结在后），不赌多键的字母序拼接。
    // position: 0=故事后聊天前 / 1=聊天内第depth层 / 2=最前；role SYSTEM=0。默认 1 + depth4。
    const INJECT_KEY = 'mp_inject';
    let injState = { enabled: false, text: '', position: 1, depth: 4 };

    function composeInjection(codexText, summaryText) {
        const parts = [];
        const cx = String(codexText != null ? codexText : '').trim();
        const sm = String(summaryText != null ? summaryText : '').trim();
        if (cx) parts.push(cx);
        if (sm) parts.push(sm);
        return parts.join('\n\n');
    }

    function applyInjection() {
        const c = ctx();
        if (!c || typeof c.setExtensionPrompt !== 'function')
            throw new Error('setExtensionPrompt 不可用（酒馆上下文未就绪）');
        const val = injState.enabled ? injState.text : '';
        // key, value, position, depth, scan=false, role=SYSTEM(0)
        c.setExtensionPrompt(INJECT_KEY, val, injState.position, injState.depth, false, 0);
        return true;
    }

    // [MP] 总结前缀正则：用于防重复替换判定
    const SUMMARY_TAG_RE = /^【前文剧情总结·第\d+卷】/;

    // [MP] 执行替换隐藏：把 rangeStart..rangeEnd 折叠成一条总结
    //   · 总结作为 rangeEnd 楼的新 swipe 并切为采用版本（原文留在旧 swipe，可左划找回）
    //   · rangeStart..rangeEnd-1 楼设 is_system 隐藏（不进提示词、UI 变灰）
    //   · 改动酒馆真实存档，saveChat 落盘。可逆。
    function applyReplace(payload) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : null;
        if (!chat) throw new Error('聊天上下文不可用');
        const rs = payload.rangeStart, re = payload.rangeEnd, vol = payload.volume;
        if (!Number.isInteger(rs) || !Number.isInteger(re) || rs > re)
            throw new Error('区间非法: ' + rs + '~' + re);
        const anchor = chat[re];
        if (!anchor) throw new Error('结束楼 ' + re + ' 不存在');
        // 防重复替换：结束楼当前采用版本已经是总结 → 拦下
        if (SUMMARY_TAG_RE.test(anchor.mes != null ? anchor.mes : ''))
            throw new Error('结束楼当前已是总结版本，已拦下重复替换（如需重做请先在酒馆左划回原文）');
        const prefix = '【前文剧情总结·第' + vol + '卷】\n';
        const summaryMes = prefix + String(payload.summaryText || '');

        // 追加总结 swipe 并切为采用；先记下还原所需的原状
        ensureSwipesLocal(anchor);
        const origMes = anchor.mes != null ? anchor.mes : '';
        const origSwipeId = anchor.swipe_id;
        anchor.swipes.push(summaryMes);
        anchor.swipe_info.push({ send_date: anchor.send_date, gen_started: null, gen_finished: null, extra: {} });
        anchor.swipe_id = anchor.swipes.length - 1;
        anchor.mes = summaryMes;
        if (anchor.extra) delete anchor.extra.token_count; // 令 token 数重算

        // 隐藏 rangeStart..rangeEnd-1（照抄 hideChatMessageRange：改 is_system + DOM 属性）
        // 只记录本次真正从"可见"翻成"隐藏"的楼，还原时才不会误动本来就隐藏的楼
        const hiddenFloors = [];
        for (let i = rs; i <= re - 1; i++) {
            if (chat[i] && !chat[i].is_system) { chat[i].is_system = true; hiddenFloors.push(i); }
        }
        try {
            if (window.$) {
                hiddenFloors.forEach(function (i) { window.$('.mes[mesid="' + i + '"]').attr('is_system', 'true'); });
            }
        } catch (e) { /* DOM 更新失败不致命，数据已改 */ }

        // 重渲染结束楼 + 刷新划动按钮
        if (typeof c.updateMessageBlock === 'function') {
            try { c.updateMessageBlock(re, anchor); } catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
        }
        if (typeof c.refreshSwipeButtons === 'function') {
            try { c.refreshSwipeButtons(); } catch (e) { /* 非致命 */ }
        }
        return {
            rangeStart: rs, rangeEnd: re, volume: vol, origMes: origMes, origSwipeId: origSwipeId, hiddenFloors: hiddenFloors,
            // [MP] 回传结束楼的新状态，蜜脾据此就地刷新，无需再拉巨型快照
            anchorMes: anchor.mes, anchorSwipeId: anchor.swipe_id, anchorSwipes: anchor.swipes.slice(),
        };
    }

    // [MP] 还原：撤销某卷替换隐藏——把原文写回结束楼、取消隐藏。绕开酒馆"中间楼不能划swipe"的限制。
    function revertReplace(payload) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : null;
        if (!chat) throw new Error('聊天上下文不可用');
        const re = payload.rangeEnd, vol = payload.volume;
        if (!Number.isInteger(re)) throw new Error('结束楼非法');
        const anchor = chat[re];
        if (!anchor) throw new Error('结束楼 ' + re + ' 不存在');
        const tag = '【前文剧情总结·第' + vol + '卷】';
        const origMes = typeof payload.origMes === 'string' ? payload.origMes : '';

        // 剔除本卷的总结 swipe（保持 swipes / swipe_info 同步）
        if (Array.isArray(anchor.swipes)) {
            const keep = [];
            for (let i = 0; i < anchor.swipes.length; i++) {
                if (!String(anchor.swipes[i] != null ? anchor.swipes[i] : '').startsWith(tag)) keep.push(i);
            }
            const hadInfo = Array.isArray(anchor.swipe_info);
            let newSwipes = keep.map(function (i) { return anchor.swipes[i]; });
            let newInfo = hadInfo ? keep.map(function (i) { return anchor.swipe_info[i]; }) : null;
            if (newSwipes.length === 0) {
                newSwipes = [origMes];
                if (hadInfo) newInfo = [{ send_date: anchor.send_date, gen_started: null, gen_finished: null, extra: {} }];
            }
            anchor.swipes = newSwipes;
            if (hadInfo) anchor.swipe_info = newInfo;
        }
        // 恢复采用版本
        let sid = Number.isInteger(payload.origSwipeId) ? payload.origSwipeId : 0;
        if (sid < 0 || sid >= anchor.swipes.length) sid = 0;
        anchor.swipe_id = sid;
        anchor.mes = origMes.length ? origMes : (anchor.swipes[sid] != null ? anchor.swipes[sid] : '');
        anchor.swipes[sid] = anchor.mes;
        if (anchor.extra) delete anchor.extra.token_count;

        // 取消隐藏（仅当初被本次翻动的那些楼）
        const floors = Array.isArray(payload.hiddenFloors) ? payload.hiddenFloors : [];
        floors.forEach(function (i) { if (chat[i]) chat[i].is_system = false; });
        try {
            if (window.$) {
                floors.forEach(function (i) { window.$('.mes[mesid="' + i + '"]').attr('is_system', 'false'); });
            }
        } catch (e) { /* 非致命 */ }

        if (typeof c.updateMessageBlock === 'function') {
            try { c.updateMessageBlock(re, anchor); } catch (e) { console.warn(TAG, 'updateMessageBlock 失败', e); }
        }
        if (typeof c.refreshSwipeButtons === 'function') {
            try { c.refreshSwipeButtons(); } catch (e) { /* 非致命 */ }
        }
        return {
            rangeEnd: re, volume: vol, hiddenFloors: floors,
            // [MP] 回传结束楼还原后的状态，蜜脾据此就地刷新，无需再拉巨型快照
            anchorMes: anchor.mes, anchorSwipeId: anchor.swipe_id, anchorSwipes: anchor.swipes.slice(),
        };
    }

    // [MP] 指令处理：vault → 桥
    channel.onmessage = function (ev) {
        const msg = ev && ev.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'ping':
                send('pong');
                break;
            case 'cancel-inflight': {
                // [MP] vault 刷新/重开时调用：掐掉所有还挂着的副API请求，连接释放、不留僵尸拖累下一发
                let n = 0;
                inflight.forEach(function (ctrl) { try { ctrl.abort(); n++; } catch (e) {} });
                inflight.clear();
                if (n > 0) { try { send('bridge-debug', { message: '已掐断 ' + n + ' 个残留副API请求（vault重开清场）' }); } catch (e) {} }
                break;
            }
            case 'get-snapshot':
                try {
                    send('snapshot', buildSnapshot());
                } catch (e) {
                    console.error(TAG, 'buildSnapshot failed', e);
                    send('error', { op: 'get-snapshot', message: String(e && e.message || e) });
                }
                break;
            case 'get-models': {
                // [MP] payload: {apiConfig} — 走 TavernHelper.getModelList（经酒馆后端同源代理，绕开CORS）
                const mp = msg.payload || {};
                (async function () {
                    try {
                        if (!(window.TavernHelper && typeof window.TavernHelper.getModelList === 'function'))
                            throw new Error('TavernHelper.getModelList 不可用（JS-Slash-Runner 未装/未就绪）');
                        const cfg = mp.apiConfig || {};
                        if (!cfg.apiurl) throw new Error('apiurl 缺失');
                        const models = await window.TavernHelper.getModelList({ apiurl: cfg.apiurl, key: cfg.key || '' });
                        send('models-result', { ok: true, models: Array.isArray(models) ? models : [] });
                    } catch (e) {
                        console.error(TAG, 'get-models failed', e);
                        send('models-result', { ok: false, message: String(e && e.message || e) });
                    }
                })();
                break;
            }
            case 'test-api': {
                // [MP] payload: {apiConfig} — 发一句最短请求探连通，不入库
                const tp = msg.payload || {};
                (async function () {
                    try {
                        const reply = await callSubApi(tp.apiConfig, '你是连通测试。只回复两个字：在。', '在吗', { label: '桥连接测试', timeoutMs: 30000 });
                        send('test-result', { ok: true, text: String(reply || '').trim() });
                    } catch (e) {
                        console.error(TAG, 'test-api failed', e);
                        send('test-result', { ok: false, message: String(e && e.message || e) });
                    }
                })();
                break;
            }
            case 'set-injection': {
                // [MP] payload: {enabled, codexText, summaryText, position, depth}
                //   vault 是注入内容的唯一真源；开关/位置/深度改动或切聊天后由 vault 重发。
                const ip = msg.payload || {};
                try {
                    injState.enabled = !!ip.enabled;
                    injState.position = Number.isInteger(ip.position) ? ip.position : 1;
                    injState.depth = Number.isInteger(ip.depth) && ip.depth >= 0 ? ip.depth : 4;
                    injState.text = composeInjection(ip.codexText, ip.summaryText);
                    applyInjection();
                    send('injection-result', {
                        ok: true, enabled: injState.enabled, position: injState.position,
                        depth: injState.depth, length: injState.text.length,
                    });
                } catch (e) {
                    console.error(TAG, 'set-injection failed', e);
                    send('injection-result', { ok: false, message: String(e && e.message || e) });
                }
                break;
            }
            case 'get-range-text': {
                // [MP] payload: {reqId, rangeStart, rangeEnd} — 只取区间原文回给网页，网页自己发总结请求。
                //      长请求挪到前台网页发（永不被手机挂起冻结）；桥只干这种秒回的短活。
                const gp = msg.payload || {};
                try {
                    const text = collectRangeText(gp.rangeStart, gp.rangeEnd);
                    send('range-text', { reqId: gp.reqId, rangeStart: gp.rangeStart, rangeEnd: gp.rangeEnd, text: text });
                } catch (e) {
                    console.error(TAG, 'get-range-text failed', e);
                    send('range-text', { reqId: gp.reqId, ok: false, message: String(e && e.message || e) });
                }
                break;
            }
            case 'run-summary': {
                // [MP] payload: {rangeStart, rangeEnd, apiConfig, summaryPrompt}
                const p = msg.payload || {};
                (async function () {
                    try {
                        const src = collectRangeText(p.rangeStart, p.rangeEnd);
                        const summary = await callSubApi(p.apiConfig, p.summaryPrompt, src, { label: '总结', timeoutMs: 80000, retries: 1 });
                        if (!summary || !String(summary).trim()) {
                            send('error', {
                                op: 'run-summary', reqId: p.reqId,
                                message: '副API返回空内容（读到区间原文 ' + src.length + ' 字，但模型没吐正文）。'
                                    + '常见原因：模型拒绝/过滤了内容，或用的是思考模型把正文塞进了思考字段。换个非思考模型或换模型试试。',
                            });
                            return;
                        }
                        send('summary', { reqId: p.reqId, rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, text: summary });
                    } catch (e) {
                        console.error(TAG, 'run-summary failed', e);
                        send('error', { op: 'run-summary', reqId: p.reqId, message: String(e && e.message || e) });
                    }
                })();
                break;
            }
            case 'apply-replace': {
                // [MP] payload: {rangeStart, rangeEnd, summaryText, volume} — 改真实存档，务必已在vault二次确认
                const ap = msg.payload || {};
                (async function () {
                    send('bridge-debug', { message: 'apply-replace 已到桥，开始改存档' }); // [MP] 计时探针：标记入桥时刻
                    let r;
                    try {
                        r = applyReplace(ap);
                    } catch (e) {
                        console.error(TAG, 'apply-replace failed', e);
                        send('apply-result', { ok: false, message: String(e && e.message || e) });
                        return;
                    }
                    // [MP] 先回执让蜜脾界面秒刷（还原三件套一并回传，否则 vault 存的 revert.hiddenFloors 为空→还原翻不动隐藏楼）
                    send('apply-result', {
                        ok: true, rangeStart: r.rangeStart, rangeEnd: r.rangeEnd, volume: r.volume,
                        origMes: r.origMes, origSwipeId: r.origSwipeId, hiddenFloors: r.hiddenFloors,
                        anchorMes: r.anchorMes, anchorSwipeId: r.anchorSwipeId, anchorSwipes: r.anchorSwipes,
                    });
                    // [MP] 存盘丢后台异步写，不让 vault 干等写盘（写盘可能一两秒）；真失败了单独发 error 提醒
                    try {
                        const c = ctx();
                        const save = (c && (c.saveChat || c.saveChatConditional)) || null;
                        if (typeof save === 'function') await save();
                    } catch (e2) {
                        console.error(TAG, 'apply save failed', e2);
                        send('error', { op: 'apply-save', message: '隐藏已生效但写盘失败：' + String(e2 && e2.message || e2) });
                    }
                })();
                break;
            }
            case 'revert-replace': {
                // [MP] payload: {rangeEnd, volume, origMes, origSwipeId, hiddenFloors} — 撤销替换，改真实存档
                const rp = msg.payload || {};
                (async function () {
                    send('bridge-debug', { message: 'revert-replace 已到桥，开始改存档' }); // [MP] 计时探针：标记入桥时刻
                    let r;
                    try {
                        r = revertReplace(rp);
                    } catch (e) {
                        console.error(TAG, 'revert-replace failed', e);
                        send('revert-result', { ok: false, message: String(e && e.message || e) });
                        return;
                    }
                    // [MP] 先回执让蜜脾界面秒刷，存盘丢后台
                    send('revert-result', {
                        ok: true, rangeEnd: r.rangeEnd, volume: r.volume, hiddenFloors: r.hiddenFloors,
                        anchorMes: r.anchorMes, anchorSwipeId: r.anchorSwipeId, anchorSwipes: r.anchorSwipes,
                    });
                    try {
                        const c = ctx();
                        const save = (c && (c.saveChat || c.saveChatConditional)) || null;
                        if (typeof save === 'function') await save();
                    } catch (e2) {
                        console.error(TAG, 'revert save failed', e2);
                        send('error', { op: 'revert-save', message: '还原已生效但写盘失败：' + String(e2 && e2.message || e2) });
                    }
                })();
                break;
            }
            default:
                // 其余 type（chat-changed/chat-dirty/snapshot/pong 等）为桥自身或其他桥的广播，忽略
                break;
        }
    };

    // [MP] 事件监听 → 广播
    function wireEvents() {
        const c = ctx();
        if (!c || !c.eventSource || !c.eventTypes) {
            console.warn(TAG, 'eventSource 未就绪，200ms 后重试');
            setTimeout(wireEvents, 200);
            return;
        }
        const es = c.eventSource;
        const et = c.eventTypes;

        es.on(et.CHAT_CHANGED, function () {
            // [MP] 换聊天：注入内容按 chatKey 不同，先就地清空，等 vault 按新聊天重发，杜绝把上一个聊天的档案带过去
            injState.enabled = false; injState.text = '';
            try { applyInjection(); } catch (e) { /* 上下文可能未就绪，忽略 */ }
            send('chat-changed');
        });

        const dirty = [
            et.MESSAGE_SENT, et.MESSAGE_RECEIVED, et.MESSAGE_DELETED,
            et.MESSAGE_EDITED, et.MESSAGE_UPDATED, et.MESSAGE_SWIPED,
            et.MESSAGE_SWIPE_DELETED, et.MORE_MESSAGES_LOADED,
        ];
        dirty.forEach(function (e) {
            if (e) es.on(e, function () { send('chat-dirty'); });
        });

        send('bridge-online');
        console.log(TAG, '已就绪，频道', CHANNEL);
    }

    // [MP] 楼层定位 — 魔棒菜单按钮 + 斜杠命令 /jump N，输楼层号唰一下滚过去+闪高亮，绕开滑不动的痛
    function injectJumpWidget() {
      try {
        const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

        function total() {
            const c = ctx();
            return (c && Array.isArray(c.chat)) ? c.chat.length : 0;
        }

        // [MP] 核心：滚到第 n 楼，懒加载藏着就翻出来，到位闪一下高亮
        async function jumpTo(n) {
            const cnt = total();
            if (cnt <= 0) { toast('当前没有聊天'); return; }
            if (!Number.isInteger(n) || n < 0 || n >= cnt) {
                toast('楼层要在 0 ~ ' + (cnt - 1) + ' 之间'); return;
            }
            let el = document.querySelector('.mes[mesid="' + n + '"]');
            let guard = 0;
            while (!el && guard < 600) {
                const more = document.getElementById('show_more_messages');
                if (!more) break;
                more.click();
                await sleep(110);
                el = document.querySelector('.mes[mesid="' + n + '"]');
                guard++;
            }
            if (!el) { toast('没找到 ' + n + ' 楼，可能还没加载出来'); return; }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const old = el.style.boxShadow;
            el.style.transition = 'box-shadow .25s';
            el.style.boxShadow = 'inset 0 0 0 3px #e6b04d';
            setTimeout(function () { el.style.boxShadow = old; }, 1300);
        }

        // [MP] 轻提示：有酒馆 toastr 就用，没有退化成状态栏文字
        function toast(t) {
            try { if (window.toastr) { window.toastr.info(t, '楼层定位'); return; } } catch (e) {}
            console.log(TAG, t);
        }

        // [MP] 挂载点1：魔棒菜单里加一个「楼层定位」按钮，点了弹输入框
        function addWandButton() {
            const menu = document.getElementById('extensionsMenu');
            if (!menu) { setTimeout(addWandButton, 800); return; }
            if (document.getElementById('mp_jump_wand')) return;
            const btn = document.createElement('div');
            btn.id = 'mp_jump_wand';
            btn.className = 'list-group-item flex-container flexGap5 interactable';
            btn.tabIndex = 0;
            btn.innerHTML = '<div class="fa-solid fa-crosshairs extensionsMenuExtensionButton"></div><span>楼层定位</span>';
            btn.addEventListener('click', function () {
                const cnt = total();
                if (cnt <= 0) { toast('当前没有聊天'); return; }
                const v = prompt('跳到第几楼？（0 ~ ' + (cnt - 1) + '）', '');
                if (v == null || v === '') return;
                jumpTo(parseInt(v, 10));
            });
            menu.appendChild(btn);
            console.log(TAG, '魔棒菜单已加楼层定位按钮');
        }

        // [MP] 挂载点2：斜杠命令 /jump N（手机输入框直接敲，最稳）
        function addSlashCommand() {
            const c = ctx();
            const P = c && c.SlashCommandParser;
            const S = c && c.SlashCommand;
            const A = c && c.SlashCommandArgument;
            const AT = c && c.ARGUMENT_TYPE;
            if (!P || !S) { setTimeout(addSlashCommand, 800); return; }
            try {
                if (P.commands && (P.commands['jump'] || P.commands['goto'])) return; // 防重复注册
            } catch (e) {}
            try {
                P.addCommandObject(S.fromProps({
                    name: 'jump',
                    aliases: ['goto', 'floor'],
                    callback: function (namedArgs, unnamed) {
                        const n = parseInt(String(unnamed || '').trim(), 10);
                        jumpTo(n);
                        return '';
                    },
                    unnamedArgumentList: (A && AT) ? [A.fromProps({
                        description: '楼层号（0 起，酒馆内部 mesid）',
                        typeList: [AT.NUMBER],
                        isRequired: true,
                    })] : [],
                    helpString: '跳到指定楼层并高亮：/jump 30',
                }));
                console.log(TAG, '斜杠命令 /jump 已注册');
            } catch (e) {
                console.error(TAG, '/jump 注册失败', e);
            }
        }

        addWandButton();
        addSlashCommand();
      } catch (e) {
        try { alert('[蜜脾] 楼层定位注入失败：' + (e && e.message || e)); } catch (_) {}
        console.error(TAG, '楼层定位注入失败', e);
      }
    }

    // [MP] 蜜脾面板 — 照柏宝书(Horae)那套，用酒馆原生「顶栏抽屉」把 vault.html 嵌进同一标签页。
    // 手机上两个标签页隔空喊话，后台标签会被冻结→桥假死、要反复刷新；
    // 同页 iframe 后桥与面板同生共死，BroadcastChannel 瞬达，永不再刷。
    // 结构完全照酒馆原生 .drawer：开合交给酒馆自带的 .drawer-toggle 委托，不自己造轮子；
    // 尺寸一律行内样式写死，不依赖任何会被缓存掉的独立 CSS。
    function injectVaultPanel() {
      try {
        // [MP] vault.html 同源地址：优先从本脚本 src 推导，退化到已知路径
        function vaultUrl() {
            try {
                const s = document.querySelector('script[src*="mellarium/index.js"]');
                if (s && s.src) return s.src.replace(/index\.js(\?.*)?$/, 'vault.html');
            } catch (e) {}
            return '/scripts/extensions/third-party/mellarium/vault.html';
        }

        // [MP] 挂到酒馆顶栏容器 #top-settings-holder，跟柏宝书的时钟图标同排
        function mountDrawer() {
            const holder = document.getElementById('top-settings-holder');
            if (!holder) { setTimeout(mountDrawer, 800); return; }
            if (document.getElementById('mp_drawer')) return;

            const drawer = document.createElement('div');
            drawer.id = 'mp_drawer';
            drawer.className = 'drawer';
            // [MP] closedIcon/closedDrawer = 初始收起；酒馆原生点击委托会切成 openIcon/openDrawer
            drawer.innerHTML =
                '<div class="drawer-toggle">' +
                    '<div id="mp_drawer_icon" class="drawer-icon fa-solid fa-book fa-fw closedIcon interactable" ' +
                        'title="蜜脾 Mellarium" tabindex="0"></div>' +
                '</div>' +
                '<div id="mp_drawer_content" class="drawer-content closedDrawer" ' +
                    'style="min-width:0;width:min(98vw,960px);height:82vh;padding:0;overflow:hidden;">' +
                    '<iframe id="mp_vault_frame" title="蜜脾" ' +
                        'style="width:100%;height:100%;border:0;display:block;background:#1b1b1f;"></iframe>' +
                '</div>';
            holder.appendChild(drawer);

            // [MP] 酒馆的 $('.drawer-toggle').on('click',…) 只在初始化时对已存在抽屉绑定，
            // 我这后加的抽屉接不上，得照 doNavbarIconClick 的逻辑自己绑等价开合（只切 class，
            // 显隐由核心 style.css 的 .drawer-content(display:none) ↔ .openDrawer(display:block) 负责）。
            const toggle = drawer.querySelector('.drawer-toggle');
            const content = drawer.querySelector('#mp_drawer_content');
            const iconEl = drawer.querySelector('#mp_drawer_icon');
            toggle.addEventListener('click', function () {
                const opening = !content.classList.contains('openDrawer');
                if (opening) {
                    // [MP] 照原生：开我之前，先把别的已开抽屉收掉
                    document.querySelectorAll('.openDrawer:not(.pinnedOpen)').forEach(function (el) {
                        el.classList.remove('openDrawer'); el.classList.add('closedDrawer');
                    });
                    document.querySelectorAll('.openIcon:not(.drawerPinnedOpen)').forEach(function (el) {
                        el.classList.remove('openIcon'); el.classList.add('closedIcon');
                    });
                    // [MP] 首次点开才给 iframe 上 src；之后只切显隐、iframe 常驻不重载→BroadcastChannel 长连不断
                    const frame = drawer.querySelector('#mp_vault_frame');
                    if (frame && !frame.getAttribute('src')) frame.setAttribute('src', vaultUrl());
                    content.classList.remove('closedDrawer'); content.classList.add('openDrawer');
                    iconEl.classList.remove('closedIcon'); iconEl.classList.add('openIcon');
                } else {
                    content.classList.remove('openDrawer'); content.classList.add('closedDrawer');
                    iconEl.classList.remove('openIcon'); iconEl.classList.add('closedIcon');
                }
            });
            console.log(TAG, '顶栏抽屉已挂载 #mp_drawer（自绑开合）');
        }

        mountDrawer();
      } catch (e) {
        try { alert('[蜜脾] 面板注入失败：' + (e && e.message || e)); } catch (_) {}
        console.error(TAG, '面板注入失败', e);
      }
    }

    injectJumpWidget();
    injectVaultPanel();
    // [MP] 酒馆界面/斜杠解析器可能晚于桥就绪，延时再注一次（各有防重不会叠）
    setTimeout(injectJumpWidget, 2500);
    setTimeout(injectVaultPanel, 2500);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectJumpWidget);
        document.addEventListener('DOMContentLoaded', injectVaultPanel);
    }

    wireEvents();
})();
