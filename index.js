// [MP] 蜜脾 Mellarium · 桥(bridge) — 无界面
// 职责：监听酒馆事件广播当前聊天状态；接收主页面(vault)指令并执行。
// 通信：BroadcastChannel('mellarium')，消息一律 {type, chatKey, payload}。
// 桥只干秒回的短活（快照/区间正文/替换还原/注入/改名对齐）；长请求（总结/测试）一律由 vault 前台同源直发。

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

    // [MP] 把当前在线对话写进同源共享 localStorage，供蜜脾另一个标签直接读。
    //   蜜脾在前台时酒馆这个标签常被手机冻死、桥的广播会丢；但「切/关对话」这个动作发生时酒馆一定在前台没冻，
    //   此刻同步写盘（localStorage 是同步的，冻结前就落定），蜜脾稍后切回来一读就是最新的。
    //   空串 = 酒馆当前没开任何对话（欢迎页/关了对话），让蜜脾据此清掉在线态，不再卡在旧对话上。
    function persistLiveKey() {
        try { localStorage.setItem('mp_live_chatkey', currentChatKey() || ''); } catch (e) {}
    }

    function send(type, payload) {
        channel.postMessage({ type, chatKey: currentChatKey(), payload: payload ?? null });
    }

    // [MP] ============ 接上酒馆自己的正则引擎 ============
    // 以前蜜脾发给副API的是 chat[i].mes 生原文，酒馆里配的正则一条都没跑过，
    // 于是「你在蜜脾里读到的」和「副API真正收到的」根本是两个东西。这里把两边接到同一个源头上。
    //
    // 净版 = isPrompt 档，也就是酒馆里勾了「仅格式化提示词」的那批脚本 + 没勾任何「仅」的通用脚本。
    // 这正是酒馆 Generate 里 coreChat 那一步用的同一个调用（script.js 里 getRegexedString(msg, 位置, {isPrompt:true, depth})），
    // 所以桥算出来的净版，逐字就是副API会收到的东西。
    //
    // engine.js 没被 getContext 暴露，但它是个 ES 模块。用和酒馆本体完全相同的绝对路径 import，
    // 拿到的是模块注册表里同一个实例，共享同一份脚本状态，不会各洗各的。
    let regexEngine = null;
    async function loadRegexEngine() {
        if (regexEngine) return regexEngine;
        try {
            regexEngine = await import('/scripts/extensions/regex/engine.js');
            console.log(TAG, '酒馆正则引擎已接上');
            send('regex-ready');   // [MP] 告诉蜜脾：净版这会儿算得出来了，可以把开关点亮
        } catch (e) {
            console.warn(TAG, '正则引擎载入失败，净版一律退回原文', e);
            regexEngine = null;
            // [MP] 手机上没有控制台，失败原因得能送到蜜脾屏幕上，否则就是一颗按不动的灰钮
            try { send('bridge-debug', { message: '正则引擎载入失败，净版不可用：' + String(e && e.message || e) }); } catch (e2) { }
        }
        return regexEngine;
    }

    // [MP] depth = 从最后一条「非隐藏」消息往回数的位置，照抄酒馆算法（隐藏楼不进上下文，所以不计数）。
    // 配了 minDepth/maxDepth 的正则脚本靠这个数决定跑不跑，算错了洗出来就跟真实发送不一致。
    function buildDepthMap(chat) {
        const vis = [];
        for (let i = 0; i < chat.length; i++) if (chat[i] && !chat[i].is_system) vis.push(i);
        const map = new Map();
        for (let p = 0; p < vis.length; p++) map.set(vis[p], vis.length - p - 1);
        return map;
    }

    // [MP] 洗一段文本。引擎没接上、或者洗炸了，一律原样退回：净版可以缺席，不能骗人。
    function cleanOne(raw, isUser, depth) {
        const s = raw != null ? String(raw) : '';
        if (!s) return '';
        if (!regexEngine || typeof regexEngine.getRegexedString !== 'function') return s;
        try {
            const p = isUser ? regexEngine.regex_placement.USER_INPUT : regexEngine.regex_placement.AI_OUTPUT;
            const opts = { isPrompt: true };
            if (Number.isInteger(depth)) opts.depth = depth;
            return regexEngine.getRegexedString(s, p, opts);
        } catch (e) {
            console.warn(TAG, '正则清洗出错，该条退回原文', e);
            return s;
        }
    }

    // [MP] 快照：当前聊天全部消息的只读拷贝 + 每条的净版
    function buildSnapshot() {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const dm = buildDepthMap(chat);
        const messages = chat.map(function (m, i) {
            const hasSwipes = Array.isArray(m.swipes) && m.swipes.length > 0;
            const swipes = hasSwipes ? m.swipes.slice() : [m.mes != null ? m.mes : ''];
            let swipeId = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
            if (swipeId < 0 || swipeId >= swipes.length) swipeId = 0;
            const mes = m.mes != null ? m.mes : '';
            const depth = dm.has(i) ? dm.get(i) : null;
            // [MP] 净版只洗 m.mes，也就是酒馆此刻显示的那一版。
            // 其余 swipe 一律不洗：那些版本酒馆没在显示、也从来没被送去过副API，
            // 给它们编一个「净版」就是撒谎。净版是一张「酒馆现在长这样」的快照，不是逐版本的翻译。
            // 洗完跟原文一模一样就传 null，让蜜脾那边自己回落。
            const mesClean = cleanOne(mes, m.is_user, depth);
            return {
                floorIndex: i,
                name: m.name != null ? m.name : '',
                is_user: !!m.is_user,
                is_system: !!m.is_system,          // [MP] 隐藏标记
                mes: mes,                           // 当前采用版本原文
                mesClean: mesClean === mes ? null : mesClean,   // 净版快照；null=跟原文没差别
                swipes: swipes,                     // 全部版本原文（只在「原文」档下能翻）
                swipeId: swipeId,                   // 酒馆此刻显示的是第几版
                sendDate: m.send_date != null ? m.send_date : null, // 指纹1
            };
        });
        // [MP] 附带角色卡文件名(avatar png)：vault 直连服务器改名时要拿它当 avatar_url，缓存下来免得再问一趟
        const avatar = (c && c.characters && c.characterId != null && c.characters[c.characterId]
            && c.characters[c.characterId].avatar) || null;
        return {
            chatKey: currentChatKey(), messages: messages, count: messages.length, avatar: avatar,
            regexReady: !!regexEngine,   // [MP] false = 引擎没接上，净版这份数据是假的，蜜脾据此禁用开关
        };
    }

    // [MP] 读取区间正文拼接，喂给副API（含user楼与#0楼，不过滤）。
    // 这里走净版：副API收到的和你在蜜脾里切到净版看到的，是同一串字。
    function collectRangeText(rangeStart, rangeEnd) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart > rangeEnd)
            throw new Error('区间非法: ' + rangeStart + '~' + rangeEnd);
        const dm = buildDepthMap(chat);
        const parts = [];
        for (let i = rangeStart; i <= rangeEnd; i++) {
            const m = chat[i];
            if (!m) throw new Error('楼层 ' + i + ' 不存在');
            const who = m.is_user ? (c.name1 || 'User') : (m.name || 'AI');
            const txt = cleanOne(m.mes != null ? m.mes : '', m.is_user, dm.has(i) ? dm.get(i) : null);
            parts.push('【' + i + '楼·' + who + '】\n' + txt);
        }
        return parts.join('\n\n');
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
            case 'get-snapshot':
                // [MP] 先把正则引擎等到位再造快照。酒馆刚加载完那几百毫秒里 import 还没落地，
                // 这时候直接造，快照里 regexReady 就是 false，蜜脾那边净版钮点了没反应。
                loadRegexEngine().then(function () {
                    try {
                        send('snapshot', buildSnapshot());
                    } catch (e) {
                        console.error(TAG, 'buildSnapshot failed', e);
                        send('error', { op: 'get-snapshot', message: String(e && e.message || e) });
                    }
                });
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
            case 'rename-reconcile': {
                // [MP] vault 已经直连服务器把 jsonl 文件＋角色卡指针改好了，这里只负责「把酒馆这个活页里的内存态对齐」：
                //   手机后台冻结时这条消息在队列里等着，等酒馆页被切到前台解冻，立刻执行 → 内存 characters[chid].chat 改成
                //   新名 + reloadCurrentChat 重新按新名读盘。幂等：已经是新名就跳过；不是当前打开的对话也跳过。
                const rp = msg.payload || {};
                (async function () {
                    try {
                        const c = ctx();
                        if (!c || !c.characters || c.characterId == null) return;
                        const ch = c.characters[c.characterId];
                        if (!ch) return;
                        const curId = c.getCurrentChatId ? c.getCurrentChatId() : null;
                        if (rp.avatar && ch.avatar !== rp.avatar) return;      // 不是这张卡，不动
                        if (!rp.oldName || String(curId) !== String(rp.oldName)) return; // 内存里不是旧名，说明已对齐或不是当前对话
                        ch.chat = String(rp.newName || '');
                        if (typeof c.reloadCurrentChat === 'function') await c.reloadCurrentChat();
                        try { send('bridge-debug', { message: '改名内存态已对齐：' + rp.oldName + ' → ' + rp.newName }); } catch (e) {}
                    } catch (e) {
                        console.error(TAG, 'rename-reconcile failed', e);
                        // [MP] 手机没控制台：对齐失败得让蜜脾屏幕上看得见，否则酒馆内存态还挂着旧名却无人知晓
                        try { send('bridge-debug', { message: '改名内存态对齐失败：' + String(e && e.message || e) }); } catch (e2) { }
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
            persistLiveKey();   // [MP] 切/关对话即刻写入同源 localStorage，蜜脾切回来直接读
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

        persistLiveKey();   // [MP] 桥一就绪就把当前已开的对话写进 localStorage，蜜脾冷启动也能直接对齐
        send('bridge-online');
        // [MP] 正则引擎异步载，落地后自己 send('regex-ready')，蜜脾收到再来要一次快照拿净版
        loadRegexEngine();
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

        // [MP] 要楼层号一律走酒馆自家的 callGenericPopup(INPUT)：
        //   - window.prompt 在 Miel 的安卓 WebView 上被拦（不弹、静默返回 null）——魔棒按钮第一次坏；
        //   - 手搓 div 弹窗又打不进字（酒馆全局键盘钩子抢焦点/手势外 focus 不弹键盘）——第二次坏，还丑；
        //   - 酒馆原生 <dialog> 弹窗她天天在用（改名等），键盘、焦点、样式全是现成的，这才是正路。
        async function askFloor() {
            const cnt = total();
            if (cnt <= 0) { toast('当前没有聊天'); return; }
            const c = ctx();
            if (!c || typeof c.callGenericPopup !== 'function' || !c.POPUP_TYPE) {
                toast('这版酒馆没有输入弹窗接口，请直接输 /jump 楼层号'); return;
            }
            const v = await c.callGenericPopup('跳到第几楼？（0 ~ ' + (cnt - 1) + '）', c.POPUP_TYPE.INPUT, '');
            if (v === null || v === false || v === undefined || String(v).trim() === '') return;
            jumpTo(parseInt(String(v).trim(), 10));
        }

        // [MP] 挂载点1：魔棒菜单里加一个「楼层定位」按钮，点了弹酒馆原生输入窗
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
                askFloor().catch(function (e) { toast('楼层定位出错：' + (e && e.message || e)); });
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
                // [MP] 手机没控制台：注册失败送到蜜脾屏内日志，别让 /jump 无声失踪
                try { send('bridge-debug', { message: '/jump 斜杠命令注册失败：' + String(e && e.message || e) }); } catch (e2) { }
            }
        }

        addWandButton();
        addSlashCommand();
      } catch (e) {
        try { alert('[蜜脾] 楼层定位注入失败：' + (e && e.message || e)); } catch (_) {}
        console.error(TAG, '楼层定位注入失败', e);
      }
    }

    // [MP] 顶栏抽屉（把 vault.html 嵌成 iframe 的那套）已整体拆除。
    // Miel 一直是当独立网页开蜜脾的，抽屉属搁置分支，留着只会误导「还有个 iframe 宿主」。
    // 桥不依赖它：BroadcastChannel 是同源跨标签页通信，两边各自开着就能对上话。

    injectJumpWidget();
    // [MP] 酒馆界面/斜杠解析器可能晚于桥就绪，延时再注一次（有防重不会叠）
    setTimeout(injectJumpWidget, 2500);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectJumpWidget);
    }

    wireEvents();
})();
