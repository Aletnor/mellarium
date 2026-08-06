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

    // [MP] 多窗口保护（大改版第一期）：会读/改「当前对话」的指令必须核对是不是发给我的。
    //   vault 的 post() 一直在消息里带着它眼中的在线 chatKey；BroadcastChannel 是广播，
    //   同浏览器开多个酒馆标签 = 多个桥同时收到同一条指令，以前每个桥都各自执行到自己打开的对话上，
    //   错窗口的正文会被拉去当总结原料、折叠替换会打到别的对话（冻结标签还会攒着消息解冻时补执行）。
    //   现在：chatKey 对不上就静默扔掉——多窗口下对不上是常态不是错误，只有对话一致的那个桥干活。
    //   msg.chatKey 为空（vault 没有在线对话）时放行，保持旧行为。
    //   改名换档的瞬间 vault 已用新名、桥内存还是旧名，会短暂对不上：rename-reconcile 不设防，对齐后自愈。
    const MP_GUARDED_OPS = { 'get-range-text': 1, 'apply-replace': 1, 'revert-replace': 1, 'set-injection': 1 };

    // [MP] 指令处理：vault → 桥
    channel.onmessage = function (ev) {
        const msg = ev && ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (MP_GUARDED_OPS[msg.type] && msg.chatKey && msg.chatKey !== currentChatKey()) return;
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
            // [MP] behavior 用 auto(瞬移)不用 smooth：smooth 是可取消动画，弹窗关闭后酒馆把焦点还给
            //   聊天框、手机弹键盘挪视口，随便哪一下都能把 smooth 半路掐死(魔棒路径"弹不过去"的元凶)。
            el.scrollIntoView({ behavior: 'auto', block: 'center' });
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
            // 弹窗收尾还有一手：焦点还给聊天框、软键盘收起、视口回弹。等这套折腾完再跳，
            // 免得刚跳到位又被键盘收起引发的布局回流拽走。
            await sleep(350);
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

    // [MP] ============ 养成线（梦工厂式·月结养成） ============
    // 主API只写剧情，一个字的账都不记（祖训）。每来一楼AI回复（此刻酒馆必在前台没冻），
    // 桥用蜜脾的副API配置当「结算系统」：读本月正文（家长指令+剧情，净版）产出数值码<mprpg>，
    // 存 localStorage['mp_rpg::<chatKey>']，画进酒馆内悬浮面板；可选把当前状态注入主API当写作背景。
    // 数值码借鉴柏宝书(SillyTavern-Horae)的<horaerpg>行式码，砍掉归属字段（单女儿）。
    // 一楼 = 一个月；月历按结算记录数推进，不靠AI报时间。

    const RPG_INJECT_KEY = 'mp_rpg_inject';
    const RPG_ATTR_INIT = { '体力': 50, '智力': 30, '魅力': 30, '气质': 30, '道德': 40, '信仰': 30, '魔性': 0 };

    function rpgLsKey(chatKey) { return 'mp_rpg::' + chatKey; }
    function rpgLoad(chatKey) {
        if (!chatKey) return null;
        try { const s = localStorage.getItem(rpgLsKey(chatKey)); return s ? JSON.parse(s) : null; }
        catch (e) { return null; }
    }
    function rpgSave(chatKey, data) {
        try { localStorage.setItem(rpgLsKey(chatKey), JSON.stringify(data)); } catch (e) { }
    }

    function rpgNewData(child, startYear, startMonth, startAge, baseFloor) {
        return {
            on: true, inj: true, baseFloor: baseFloor,
            cfg: {
                child: child, startYear: startYear, startMonth: startMonth, startAge: startAge,
                attrMax: 999,
                attrs: ['体力', '智力', '魅力', '气质', '道德', '信仰', '魔性'],
                bars: [{ key: '疲劳', max: 100 }, { key: '压力', max: 100 }],
                moneyName: '金币',
            },
            records: [],   // [{floor, lines:[...], at}] 按 floor 升序
        };
    }

    // [MP] 月历：monthOffset=已结算月数（0=开局第一个月还没过）
    function rpgCalendar(data, monthOffset) {
        const c = data.cfg;
        const m0 = (c.startMonth - 1) + monthOffset;
        const ageM = c.startAge * 12 + monthOffset;
        return {
            year: c.startYear + Math.floor(m0 / 12), month: (m0 % 12) + 1,
            ageY: Math.floor(ageM / 12), ageM: ageM % 12,
        };
    }

    // [MP] 重放全部结算记录 → 当前状态。attr/bar 是绝对值（自愈：错一个月下月覆盖），money 支持±增量。
    function rpgReplay(data) {
        const st = { attrs: {}, bars: {}, money: 500, skills: [], rep: {}, rel: {}, status: [], events: [] };
        data.cfg.attrs.forEach(function (a) { st.attrs[a] = RPG_ATTR_INIT[a] != null ? RPG_ATTR_INIT[a] : 30; });
        data.cfg.bars.forEach(function (b) { st.bars[b.key] = [0, b.max]; });
        const recs = data.records.slice().sort(function (a, b) { return a.floor - b.floor; });
        for (let i = 0; i < recs.length; i++) rpgApplyLines(recs[i].lines, st, data, i);
        return st;
    }

    function rpgApplyLines(lines, st, data, monthIdx) {
        const maxA = data.cfg.attrMax;
        (lines || []).forEach(function (raw) {
            const line = String(raw || '').trim();
            if (!line) return;
            if (line.startsWith('attr:')) {
                line.substring(5).split('|').forEach(function (kv) {
                    const m = kv.trim().match(/^(.+?)=(-?\d+)$/);
                    if (m && st.attrs[m[1].trim()] !== undefined)
                        st.attrs[m[1].trim()] = Math.max(0, Math.min(maxA, parseInt(m[2], 10)));
                });
            } else if (line.startsWith('bar:')) {
                const m = line.substring(4).match(/^(.+?)=(\d+)\s*\/\s*(\d+)$/);
                if (m && st.bars[m[1].trim()] !== undefined)
                    st.bars[m[1].trim()] = [Math.max(0, parseInt(m[2], 10)), parseInt(m[3], 10)];
            } else if (line.startsWith('money:')) {
                const v = line.substring(6).trim().replace(/^=/, '');
                const n = parseInt(v, 10);
                if (!isNaN(n)) st.money = (/^[+-]/.test(v)) ? st.money + n : n;
            } else if (line.startsWith('skill-:')) {
                const name = line.substring(7).trim();
                st.skills = st.skills.filter(function (s) { return s.name !== name; });
            } else if (line.startsWith('skill:')) {
                const p = line.substring(6).split('|').map(function (s) { return s.trim(); });
                if (!p[0]) return;
                const hit = st.skills.find(function (s) { return s.name === p[0]; });
                if (hit) { hit.level = p[1] || hit.level; hit.desc = p[2] || hit.desc; }
                else st.skills.push({ name: p[0], level: p[1] || '', desc: p[2] || '' });
            } else if (line.startsWith('rep:')) {
                const m = line.substring(4).match(/^(.+?)=(-?\d+)$/);
                if (m) st.rep[m[1].trim()] = parseInt(m[2], 10);
            } else if (line.startsWith('rel-:')) {
                delete st.rel[line.substring(5).trim()];
            } else if (line.startsWith('rel:')) {
                const m = line.substring(4).match(/^(.+?)=(-?\d+)(?:\|(.*))?$/);
                if (m) {
                    const name = m[1].trim();
                    const old = st.rel[name];
                    st.rel[name] = {
                        v: Math.max(0, Math.min(100, parseInt(m[2], 10))),
                        tag: (m[3] || '').trim() || (old ? old.tag : ''),
                    };
                }
            } else if (line.startsWith('status:')) {
                const v = line.substring(7).trim();
                st.status = (!v || /^(正常|无|none|normal)$/i.test(v))
                    ? [] : v.split('/').map(function (s) { return s.trim(); }).filter(Boolean);
            } else if (line.startsWith('event:')) {
                const t = line.substring(6).trim();
                if (t) st.events.push({ i: monthIdx, text: t });
            }
        });
    }

    function rpgStateText(data, st) {
        const c = data.cfg;
        const lines = [];
        lines.push('属性(0~' + c.attrMax + ')：' + c.attrs.map(function (a) { return a + (st.attrs[a] != null ? st.attrs[a] : 0); }).join('、'));
        lines.push(c.bars.map(function (b) { const v = st.bars[b.key] || [0, b.max]; return b.key + v[0] + '/' + v[1]; }).join('　'));
        lines.push(c.moneyName + '：' + st.money);
        if (st.skills.length) lines.push('技能：' + st.skills.map(function (s) { return s.name + (s.level ? 'Lv' + s.level : ''); }).join('、'));
        const repKeys = Object.keys(st.rep);
        if (repKeys.length) lines.push('声望：' + repKeys.map(function (k) { return k + st.rep[k]; }).join('、'));
        const relKeys = Object.keys(st.rel);
        if (relKeys.length) lines.push('人际(好感0~100)：' + relKeys.map(function (k) {
            const r = st.rel[k]; return k + (r.tag ? '(' + r.tag + ')' : '') + r.v;
        }).join('、'));
        lines.push('状态：' + (st.status.length ? st.status.join('/') : '正常'));
        return lines.join('\n');
    }

    function rpgLastEvents(data, st, n) {
        return st.events.slice(-n).map(function (e) {
            const cal = rpgCalendar(data, e.i);
            return cal.year + '年' + cal.month + '月·' + e.text;
        }).join(' / ');
    }

    // [MP] 跨库读蜜脾 vault 的设置（IndexedDB mellarium/settings，行形状 {key,value}）。
    //   副API配置只有 vault 一份真源，桥现用现读，绝不抄第二份。
    function rpgGetVaultSetting(key, dflt) {
        return new Promise(function (resolve) {
            try {
                const req = indexedDB.open('mellarium');
                req.onsuccess = function () {
                    const d = req.result;
                    try {
                        if (!d.objectStoreNames.contains('settings')) { d.close(); resolve(dflt); return; }
                        const g = d.transaction('settings', 'readonly').objectStore('settings').get(key);
                        g.onsuccess = function () { const row = g.result; try { d.close(); } catch (e) { } resolve(row ? row.value : dflt); };
                        g.onerror = function () { try { d.close(); } catch (e) { } resolve(dflt); };
                    } catch (e) { try { d.close(); } catch (e2) { } resolve(dflt); }
                };
                req.onerror = function () { resolve(dflt); };
            } catch (e) { resolve(dflt); }
        });
    }

    async function rpgApiCfg() {
        const presets = await rpgGetVaultSetting('apiPresets', null);
        if (!Array.isArray(presets) || !presets.length) throw new Error('蜜脾里还没配副API（蜜脾→设置→副API）');
        let idx = await rpgGetVaultSetting('activePresetIdx', 0);
        if (!Number.isInteger(idx) || idx < 0 || idx >= presets.length) idx = 0;
        const p = presets[idx] || {};
        if (!p.apiurl) throw new Error('当前副API地址为空');
        const jb = await rpgGetVaultSetting('jailbreakPrompt', '');
        return {
            apiurl: p.apiurl, key: p.key || '', model: p.model || '',
            maxTokens: Number(p.maxTokens) > 0 ? Number(p.maxTokens) : 8192, jailbreak: jb || '',
        };
    }

    async function rpgCsrf() {
        const r = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-cache' });
        if (!r.ok) throw new Error('拿不到CSRF(' + r.status + ')');
        const d = await r.json(); return d && d.token;
    }

    // [MP] 结算单发：非流式（产物就几百字），120秒真超时，照抄 vault 的已验证契约
    async function rpgCallSubApi(sysPrompt, srcText) {
        const cfg = await rpgApiCfg();
        const token = await rpgCsrf();
        const base = String(cfg.apiurl).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
        const sysMsg = [String(cfg.jailbreak || '').trim(), String(sysPrompt || '').trim()].filter(Boolean).join('\n\n');
        const body = {
            stream: false,
            messages: [
                { role: 'system', content: sysMsg },
                { role: 'user', content: String(srcText || '') },
            ],
            model: cfg.model,
            chat_completion_source: 'openai',
            max_tokens: cfg.maxTokens,
            reverse_proxy: base,
            proxy_password: cfg.key,
            use_sysprompt: true,
        };
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(function () { timedOut = true; try { controller.abort(); } catch (e) { } }, 120000);
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST', cache: 'no-cache',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            let json = {}; try { json = await resp.json(); } catch (e) { }
            if (!resp.ok || (json && json.error)) throw new Error((json && json.error && json.error.message) || ('HTTP ' + resp.status));
            return (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || (json && json.content) || '';
        } catch (e) {
            if (timedOut) throw new Error('结算超时(120秒)');
            throw e;
        } finally { clearTimeout(timer); }
    }

    function rpgSettlePrompt(data, st) {
        const cal = rpgCalendar(data, data.records.length);
        return [
            '你是一个养成游戏的结算系统（美少女梦工厂式）。玩家是家长，正文是女儿这一个月的经历。',
            '你的唯一任务：根据本月正文结算女儿的数值，只输出一个<mprpg>标签块，标签块外不写任何文字。',
            '',
            '本月：' + cal.year + '年' + cal.month + '月（' + data.cfg.child + '，' + cal.ageY + '岁' + cal.ageM + '个月）',
            '当前数值：',
            rpgStateText(data, st),
            '',
            '结算规则：',
            '- attr 行必须写全所有属性，输出结算后的当前值（不是增量），范围0~' + data.cfg.attrMax + '。',
            '- 数值贴合正文：训练/上课提升对应属性并抬升疲劳压力，休息玩耍回落，重大剧情可大幅波动；正文没涉及的属性保持原值。单月单项常规变化1~15。',
            '- bar 行输出 当前/上限。money 用+或-记本月收支，没有收支不写。',
            '- 技能仅习得/升级/失去时写；声望仅变化时写。',
            '- rel 记女儿的人际好感（0~100，绝对值），本月有互动或关系变化的人物才写；新人物首次出现附上关系（如 rel:里德=35|剑术老师）；彻底断绝往来用 rel-:人名。',
            '- status 记当前生效的异常（生病/受伤/情绪问题等），没有写 正常。',
            '- event 一句话概括本月大事，20字内，必写。',
            '',
            '输出格式（每行一条）：',
            '<mprpg>',
            'attr:' + data.cfg.attrs.map(function (a) { return a + '=数值'; }).join('|'),
            data.cfg.bars.map(function (b) { return 'bar:' + b.key + '=当前/' + b.max; }).join('\n'),
            'money:+120',
            'skill:技能名|等级|一句话说明',
            'skill-:失去的技能名',
            'rep:阵营=数值',
            'rel:人名=好感|关系',
            'status:正常',
            'event:本月大事',
            '</mprpg>',
        ].join('\n');
    }

    // [MP] 抠出回复里最后一个 <mprpg> 块；AI 没包标签但直接给了裸码行，也认（宽进严出）
    function rpgParseReply(text) {
        const s = String(text || '').replace(/<think(?:ing)?[\s>][\s\S]*?<\/think(?:ing)?>/gi, '');
        let block = null;
        const matches = Array.from(s.matchAll(/<mprpg>([\s\S]*?)<\/mprpg>/gi));
        if (matches.length) block = matches[matches.length - 1][1];
        else if (/^attr:/m.test(s)) block = s;
        if (!block) return null;
        const lines = block.split('\n').map(function (l) { return l.trim(); })
            .filter(function (l) { return /^(attr|bar|money|skill|skill-|rep|rel|rel-|status|event):/.test(l); });
        return lines.length ? lines : null;
    }

    // [MP] 本月正文 = 前置的家长楼（连续 user 楼都收）＋ 本楼剧情，全走净版
    function rpgBuildSrc(floorIdx) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const dm = buildDepthMap(chat);
        const parts = [];
        let u = floorIdx - 1;
        const userParts = [];
        while (u >= 0 && chat[u] && chat[u].is_user) {
            userParts.unshift(cleanOne(chat[u].mes || '', true, dm.has(u) ? dm.get(u) : null));
            u--;
        }
        if (userParts.length) parts.push('【家长指令】\n' + userParts.join('\n'));
        const m = chat[floorIdx];
        parts.push('【本月剧情】\n' + cleanOne(m.mes || '', false, dm.has(floorIdx) ? dm.get(floorIdx) : null));
        return parts.join('\n\n');
    }

    function rpgToast(t) {
        try { if (window.toastr) { window.toastr.info(t, '养成线'); return; } } catch (e) { }
        console.log(TAG, '[养成]', t);
    }

    // [MP] 结算一楼。同时只跑一发；成功落记录，失败报屏不落。
    let rpgRunning = false;
    async function rpgSettleFloor(chatKey, floorIdx) {
        const data = rpgLoad(chatKey);
        if (!data || !data.on) return false;
        if (data.records.some(function (r) { return r.floor === floorIdx; })) return false;
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const m = chat[floorIdx];
        if (!m || m.is_user || m.is_system) return false;
        if (!String(m.mes || '').trim() || String(m.mes) === '...') return false;
        await loadRegexEngine();
        const st = rpgReplay(data);
        const cal = rpgCalendar(data, data.records.length);
        rpgSetStatus('结算 ' + cal.year + '年' + cal.month + '月…');
        const reply = await rpgCallSubApi(rpgSettlePrompt(data, st), rpgBuildSrc(floorIdx));
        const lines = rpgParseReply(reply);
        if (!lines) throw new Error('结算回复里没有找到数值码');
        // [MP] 收尾时现场重读再写：结算期间用户可能划走/删楼改过记录
        const fresh = rpgLoad(chatKey);
        if (!fresh || !fresh.on) return false;
        if (fresh.records.some(function (r) { return r.floor === floorIdx; })) return false;
        fresh.records.push({ floor: floorIdx, lines: lines, at: Date.now() });
        fresh.records.sort(function (a, b) { return a.floor - b.floor; });
        rpgSave(chatKey, fresh);
        return true;
    }

    // [MP] 补漏：把 baseFloor 之后所有没结算的AI楼按序结掉，最多 limit 发（防失控烧token）
    async function rpgCatchup(limit) {
        if (rpgRunning) return;
        const chatKey = currentChatKey();
        const data = rpgLoad(chatKey);
        if (!chatKey || !data || !data.on) return;
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const settled = {};
        data.records.forEach(function (r) { settled[r.floor] = true; });
        const todo = [];
        for (let i = data.baseFloor + 1; i < chat.length; i++) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && !settled[i] && String(m.mes || '').trim() && String(m.mes) !== '...')
                todo.push(i);
            if (todo.length >= (limit || 3)) break;
        }
        if (!todo.length) return;
        rpgRunning = true;
        try {
            for (const f of todo) {
                if (currentChatKey() !== chatKey) break;   // 中途切了对话就停
                await rpgSettleFloor(chatKey, f);
                rpgAfterChange(chatKey);
            }
            rpgSetStatus('');
        } catch (e) {
            const msg = String(e && e.message || e);
            rpgSetStatus('结算失败：' + msg);
            rpgToast('结算失败：' + msg);
            try { send('bridge-debug', { message: '[养成] 结算失败：' + msg }); } catch (e2) { }
        } finally {
            rpgRunning = false;
        }
    }

    // [MP] 记录变动后的统一收尾：刷面板 + 刷注入
    function rpgAfterChange(chatKey) {
        if (currentChatKey() !== chatKey) return;
        const data = rpgLoad(chatKey);
        const st = data ? rpgReplay(data) : null;
        rpgApplyInjection(data, st);
        rpgRefreshChip();
        if (rpgPanelOpen()) rpgRenderPanel();
    }

    function rpgApplyInjection(data, st) {
        const c = ctx();
        if (!c || typeof c.setExtensionPrompt !== 'function') return;
        let text = '';
        if (data && data.on && data.inj && st) {
            const cal = rpgCalendar(data, data.records.length);
            const ev = rpgLastEvents(data, st, 3);
            text = '【养成状态·由系统结算维护】\n'
                + '现在是' + cal.year + '年' + cal.month + '月，' + data.cfg.child + ' ' + cal.ageY + '岁' + cal.ageM + '个月。本轮剧情=这一个月。\n'
                + rpgStateText(data, st)
                + (ev ? '\n近期大事：' + ev : '')
                + '\n（写作时让剧情贴合以上状态；正文中不要罗列数值，不要输出任何标签。）';
        }
        try { c.setExtensionPrompt(RPG_INJECT_KEY, text, 1, 4, false, 0); } catch (e) { }
    }

    // [MP] ===== 面板 UI（毛玻璃+大圆角+去border，蜜金点缀） =====
    function rpgEsc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function rpgInjectStyle() {
        if (document.getElementById('mp_rpg_style')) return;
        const css = [
            '#mp_rpg_chip{position:fixed;right:6px;top:30vh;z-index:9999;width:40px;height:40px;border-radius:50%;',
            ' background:rgba(24,20,28,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
            ' display:flex;align-items:center;justify-content:center;color:#e6b04d;font-size:17px;cursor:pointer;',
            ' box-shadow:0 2px 10px rgba(0,0,0,.35);opacity:.82}',
            '#mp_rpg_mask{position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;box-sizing:border-box;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}',
            '#mp_rpg_card{width:min(420px,94vw);max-width:420px;margin:auto;box-sizing:border-box;max-height:82vh;overflow-y:auto;border-radius:20px;padding:18px 16px 14px;',
            ' background:rgba(26,22,30,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);',
            ' color:#eee;font-size:13px;font-weight:400;line-height:1.55;box-shadow:0 8px 40px rgba(0,0,0,.5)}',
            '.mp-rpg-h{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}',
            '.mp-rpg-name{font-size:17px;color:#e6b04d}',
            '.mp-rpg-sub{opacity:.65;font-size:12px}',
            '.mp-rpg-x{margin-left:auto;font-size:18px;opacity:.6;cursor:pointer;padding:2px 6px}',
            '.mp-rpg-status{font-size:12px;color:#e6b04d;opacity:.9;min-height:16px;margin-bottom:6px}',
            '.mp-rpg-sec{margin:10px 0 4px;font-size:12px;letter-spacing:2px;opacity:.55}',
            '.mp-rpg-row{display:flex;align-items:center;gap:8px;padding:2.5px 0}',
            '.mp-rpg-k{width:3.2em;opacity:.85}',
            '.mp-rpg-v{width:3em;text-align:right;color:#e6b04d;font-variant-numeric:tabular-nums}',
            '.mp-rpg-track{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden}',
            '.mp-rpg-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#c98f2e,#e6b04d)}',
            '.mp-rpg-fill.warn{background:linear-gradient(90deg,#a04545,#d96a6a)}',
            '.mp-rpg-chips{display:flex;flex-wrap:wrap;gap:5px}',
            '.mp-rpg-chip2{background:rgba(230,176,77,.14);color:#e6c98a;border-radius:9px;padding:2px 9px;font-size:12px}',
            '.mp-rpg-ev{opacity:.8;font-size:12px;padding:1.5px 0}',
            '.mp-rpg-btns{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}',
            '.mp-rpg-btn{flex:1 1 auto;text-align:center;border-radius:11px;padding:7px 6px;font-size:12px;cursor:pointer;',
            ' background:rgba(255,255,255,.08);color:#ddd;white-space:nowrap}',
            '.mp-rpg-btn.gold{background:rgba(230,176,77,.2);color:#e6b04d}',
            '.mp-rpg-empty{text-align:center;opacity:.75;padding:18px 6px;line-height:1.9}',
        ].join('\n');
        const el = document.createElement('style');
        el.id = 'mp_rpg_style';
        el.textContent = css;
        document.head.appendChild(el);
    }

    let rpgStatusMsg = '';
    function rpgSetStatus(t) {
        rpgStatusMsg = t || '';
        const el = document.getElementById('mp_rpg_status');
        if (el) el.textContent = rpgStatusMsg;
    }

    function rpgPanelOpen() { return !!document.getElementById('mp_rpg_mask'); }

    function rpgRefreshChip() {
        rpgInjectStyle();
        const data = rpgLoad(currentChatKey());
        let chip = document.getElementById('mp_rpg_chip');
        if (!data || !data.on) { if (chip) chip.remove(); return; }
        if (!chip) {
            chip = document.createElement('div');
            chip.id = 'mp_rpg_chip';
            chip.innerHTML = '<i class="fa-solid fa-crown"></i>';
            chip.addEventListener('click', rpgOpenPanel);
            document.body.appendChild(chip);
        }
    }

    function rpgOpenPanel() {
        rpgInjectStyle();
        if (rpgPanelOpen()) return;
        const mask = document.createElement('div');
        mask.id = 'mp_rpg_mask';
        // [MP] Miel的WebView不认 inset 简写，样式表指不上，遮罩全屏＋居中直接内联写死
        mask.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;box-sizing:border-box;'
            + 'z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
        mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
        mask.innerHTML = '<div id="mp_rpg_card"></div>';
        document.body.appendChild(mask);
        rpgRenderPanel();
    }

    function rpgBarRow(label, val, max, warn) {
        const pct = max > 0 ? Math.max(0, Math.min(100, val / max * 100)) : 0;
        return '<div class="mp-rpg-row"><span class="mp-rpg-k">' + rpgEsc(label) + '</span>'
            + '<div class="mp-rpg-track"><div class="mp-rpg-fill' + (warn ? ' warn' : '') + '" style="width:' + pct.toFixed(1) + '%"></div></div>'
            + '<span class="mp-rpg-v">' + val + '</span></div>';
    }

    function rpgRenderPanel() {
        const card = document.getElementById('mp_rpg_card');
        if (!card) return;
        const chatKey = currentChatKey();
        const data = rpgLoad(chatKey);
        if (!chatKey) { card.innerHTML = '<div class="mp-rpg-empty">先在酒馆里打开一个对话</div>'; return; }
        if (!data) {
            card.innerHTML = '<div class="mp-rpg-empty">这条对话还没开养成线。<br>开启后：一楼=一个月，每楼AI回复后<br>由副API自动结算女儿的数值。</div>'
                + '<div class="mp-rpg-btns"><div class="mp-rpg-btn gold" id="mp_rpg_enable">开启养成线</div></div>';
            document.getElementById('mp_rpg_enable').addEventListener('click', function () { rpgSetup(null); });
            return;
        }
        const st = rpgReplay(data);
        const cal = rpgCalendar(data, data.records.length);
        const adultM = Math.max(0, 18 * 12 - (data.cfg.startAge * 12 + data.records.length));
        let h = '';
        h += '<div class="mp-rpg-h"><span class="mp-rpg-name">' + rpgEsc(data.cfg.child) + '</span>'
            + '<span class="mp-rpg-sub">' + cal.ageY + '岁' + cal.ageM + '个月 · ' + cal.year + '年' + cal.month + '月</span>'
            + '<span class="mp-rpg-x" id="mp_rpg_close">×</span></div>';
        h += '<div class="mp-rpg-sub">已结算' + data.records.length + '个月 · 距成年' + adultM + '个月' + (data.on ? '' : ' · 已停用') + '</div>';
        h += '<div class="mp-rpg-status" id="mp_rpg_status">' + rpgEsc(rpgStatusMsg) + '</div>';
        h += '<div class="mp-rpg-sec">属性</div>';
        data.cfg.attrs.forEach(function (a) { h += rpgBarRow(a, st.attrs[a] != null ? st.attrs[a] : 0, data.cfg.attrMax, false); });
        h += '<div class="mp-rpg-sec">身心</div>';
        data.cfg.bars.forEach(function (b) {
            const v = st.bars[b.key] || [0, b.max];
            h += rpgBarRow(b.key, v[0], v[1], v[0] / (v[1] || 1) >= 0.7);
        });
        h += '<div class="mp-rpg-row"><span class="mp-rpg-k">' + rpgEsc(data.cfg.moneyName) + '</span><span style="color:#e6b04d">' + st.money + '</span>'
            + '<span style="margin-left:auto;opacity:.75">' + rpgEsc(st.status.length ? st.status.join('/') : '状态良好') + '</span></div>';
        h += '<div class="mp-rpg-sec">技能</div>';
        h += st.skills.length
            ? '<div class="mp-rpg-chips">' + st.skills.map(function (s) {
                return '<span class="mp-rpg-chip2" title="' + rpgEsc(s.desc) + '">' + rpgEsc(s.name) + (s.level ? '·Lv' + rpgEsc(s.level) : '') + '</span>';
            }).join('') + '</div>'
            : '<div class="mp-rpg-ev" style="opacity:.45">还没学会任何技能</div>';
        const relKeys = Object.keys(st.rel);
        h += '<div class="mp-rpg-sec">人际</div>';
        h += relKeys.length
            ? '<div class="mp-rpg-chips">' + relKeys.map(function (k) {
                const r = st.rel[k];
                return '<span class="mp-rpg-chip2"' + (r.tag ? ' title="' + rpgEsc(r.tag) + '"' : '') + '>'
                    + rpgEsc(k) + ' ♥' + r.v + (r.tag ? ' <span style="opacity:.6">' + rpgEsc(r.tag) + '</span>' : '') + '</span>';
            }).join('') + '</div>'
            : '<div class="mp-rpg-ev" style="opacity:.45">还没结识什么人</div>';
        const repKeys = Object.keys(st.rep);
        h += '<div class="mp-rpg-sec">声望</div>';
        h += repKeys.length
            ? '<div class="mp-rpg-chips">' + repKeys.map(function (k) { return '<span class="mp-rpg-chip2">' + rpgEsc(k) + ' ' + st.rep[k] + '</span>'; }).join('') + '</div>'
            : '<div class="mp-rpg-ev" style="opacity:.45">默默无闻</div>';
        h += '<div class="mp-rpg-sec">大事记</div>';
        if (st.events.length) {
            st.events.slice(-6).reverse().forEach(function (e) {
                const c2 = rpgCalendar(data, e.i);
                h += '<div class="mp-rpg-ev">' + c2.year + '年' + c2.month + '月　' + rpgEsc(e.text) + '</div>';
            });
        } else {
            h += '<div class="mp-rpg-ev" style="opacity:.45">第一个月还没过完</div>';
        }
        h += '<div class="mp-rpg-btns">'
            + '<div class="mp-rpg-btn gold" id="mp_rpg_catchup">补结算</div>'
            + '<div class="mp-rpg-btn" id="mp_rpg_redo">重算上月</div>'
            + '<div class="mp-rpg-btn" id="mp_rpg_inj">注入：' + (data.inj ? '开' : '关') + '</div>'
            + '<div class="mp-rpg-btn" id="mp_rpg_cfg">设置</div>'
            + '<div class="mp-rpg-btn" id="mp_rpg_off">停用</div>'
            + '</div>';
        card.innerHTML = h;
        document.getElementById('mp_rpg_close').addEventListener('click', function () {
            const mask = document.getElementById('mp_rpg_mask'); if (mask) mask.remove();
        });
        document.getElementById('mp_rpg_catchup').addEventListener('click', function () { rpgCatchup(5); });
        document.getElementById('mp_rpg_redo').addEventListener('click', function () {
            const d = rpgLoad(chatKey);
            if (!d || !d.records.length) { rpgToast('还没有可重算的月份'); return; }
            d.records.pop();
            rpgSave(chatKey, d);
            rpgAfterChange(chatKey);
            rpgCatchup(1);
        });
        document.getElementById('mp_rpg_inj').addEventListener('click', function () {
            const d = rpgLoad(chatKey); if (!d) return;
            d.inj = !d.inj; rpgSave(chatKey, d); rpgAfterChange(chatKey);
        });
        document.getElementById('mp_rpg_cfg').addEventListener('click', function () { rpgSetup(rpgLoad(chatKey)); });
        document.getElementById('mp_rpg_off').addEventListener('click', function () {
            const d = rpgLoad(chatKey); if (!d) return;
            if (!window.confirm('停用养成线？（记录保留，重开续玩）')) return;
            d.on = false; rpgSave(chatKey, d);
            rpgAfterChange(chatKey);
            const mask = document.getElementById('mp_rpg_mask'); if (mask) mask.remove();
        });
    }

    // [MP] 开启/设置：走酒馆原生弹窗（window.prompt 在Miel的WebView上被拦，教训见楼层定位）
    async function rpgSetup(existing) {
        const c = ctx();
        const chatKey = currentChatKey();
        if (!chatKey) { rpgToast('先在酒馆里打开一个对话'); return; }
        if (!c || typeof c.callGenericPopup !== 'function' || !c.POPUP_TYPE) { rpgToast('这版酒馆没有输入弹窗接口'); return; }
        const d0 = existing;
        const name = await c.callGenericPopup('女儿的名字？', c.POPUP_TYPE.INPUT, (d0 && d0.cfg.child) || '莉莉安');
        if (name === null || name === false || String(name).trim() === '') return;
        const ym = await c.callGenericPopup('开局年月？（年-月，历法随世界观）', c.POPUP_TYPE.INPUT,
            d0 ? (d0.cfg.startYear + '-' + d0.cfg.startMonth) : '1210-4');
        if (ym === null || ym === false) return;
        const m = String(ym).trim().match(/^(\d{1,5})\s*[-年/.]\s*(\d{1,2})/);
        const age = await c.callGenericPopup('开局年龄？（梦工厂传统是10岁）', c.POPUP_TYPE.INPUT, d0 ? String(d0.cfg.startAge) : '10');
        if (age === null || age === false) return;
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        if (d0) {
            d0.on = true;
            d0.cfg.child = String(name).trim();
            if (m) { d0.cfg.startYear = parseInt(m[1], 10); d0.cfg.startMonth = Math.min(12, Math.max(1, parseInt(m[2], 10))); }
            const a = parseInt(String(age).trim(), 10);
            if (!isNaN(a) && a > 0) d0.cfg.startAge = a;
            rpgSave(chatKey, d0);
        } else {
            const y = m ? parseInt(m[1], 10) : 1210;
            const mo = m ? Math.min(12, Math.max(1, parseInt(m[2], 10))) : 4;
            const a = parseInt(String(age).trim(), 10);
            // [MP] baseFloor=当前最后一楼：开场白和之前的楼不算月份，从下一楼AI回复开始过日子
            const data = rpgNewData(String(name).trim(), y, mo, (!isNaN(a) && a > 0) ? a : 10, Math.max(0, chat.length - 1));
            rpgSave(chatKey, data);
            rpgToast('养成线已开启：' + data.cfg.child + '，' + y + '年' + mo + '月');
        }
        rpgAfterChange(chatKey);
    }

    // [MP] 魔棒菜单入口
    function rpgAddWandButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) { setTimeout(rpgAddWandButton, 800); return; }
        if (document.getElementById('mp_rpg_wand')) return;
        const btn = document.createElement('div');
        btn.id = 'mp_rpg_wand';
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.tabIndex = 0;
        btn.innerHTML = '<div class="fa-solid fa-crown extensionsMenuExtensionButton"></div><span>养成面板</span>';
        btn.addEventListener('click', rpgOpenPanel);
        menu.appendChild(btn);
    }

    // [MP] 事件接线：自带重试，独立于 wireEvents（不搅正文那套）
    function wireRpgEvents() {
        const c = ctx();
        if (!c || !c.eventSource || !c.eventTypes) { setTimeout(wireRpgEvents, 300); return; }
        const es = c.eventSource, et = c.eventTypes;
        es.on(et.CHAT_CHANGED, function () {
            const chatKey = currentChatKey();
            rpgAfterChange(chatKey || '');
            rpgRefreshChip();
        });
        if (et.MESSAGE_RECEIVED) es.on(et.MESSAGE_RECEIVED, function () {
            // [MP] 稍等一拍：让酒馆把楼落稳、正则引擎就绪，再取净版结算
            setTimeout(function () { rpgCatchup(3); }, 900);
        });
        if (et.MESSAGE_SWIPED) es.on(et.MESSAGE_SWIPED, function () {
            // [MP] 最后一楼被划走：本月记录作废，新版本回来（MESSAGE_RECEIVED/补结算）自动重结
            const chatKey = currentChatKey();
            const data = rpgLoad(chatKey);
            if (!data || !data.on) return;
            const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
            const last = chat.length - 1;
            const before = data.records.length;
            data.records = data.records.filter(function (r) { return r.floor !== last; });
            if (data.records.length !== before) {
                rpgSave(chatKey, data);
                rpgAfterChange(chatKey);
                rpgToast('本月已划走，等新版本回来自动重算');
            }
        });
        if (et.MESSAGE_DELETED) es.on(et.MESSAGE_DELETED, function () {
            // [MP] 删楼后楼号整体前移没法逐条对账；只把越界记录清掉，错位靠「重算上月/补结算」兜底
            const chatKey = currentChatKey();
            const data = rpgLoad(chatKey);
            if (!data) return;
            const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
            const before = data.records.length;
            data.records = data.records.filter(function (r) { return r.floor < chat.length; });
            if (data.records.length !== before) { rpgSave(chatKey, data); rpgAfterChange(chatKey); }
        });
        // 就绪后对当前对话先对一遍状态
        rpgRefreshChip();
        const key = currentChatKey();
        if (key) rpgAfterChange(key);
    }

    function rpgInit() {
        rpgInjectStyle();
        rpgAddWandButton();
        setTimeout(rpgAddWandButton, 2500);
        wireRpgEvents();
    }

    // [MP] ============ 每楼摘要线（大改版第一期） ============
    // 主API纯写文，一个字的账都不记（祖训）。每楼AI回复落地后（此刻酒馆必在前台没冻），
    // 桥用蜜脾的副API配置给这楼出一段摘要，写回该楼正文末尾的 <details> 折叠块。
    // 送递靠两条自动安装的酒馆全局正则（仅格式化提示词）：近楼删摘要块（主AI看全文）、
    // 远楼只留摘要（省上下文）。正则装好后蜜脾网页关着也照常生效。
    // 状态就住在正文里，不另设账本：重骰=新版本天生没折叠块=自动重做；改几个字块还在=不重做；
    // 划回旧版本=旧摘要跟着旧正文一起回来。老楼补漏走魔棒菜单「摘要补漏」（必须前台跑，见下）。

    const ABS_BLOCK_START = '<details data-mp-abs="1"><summary>本楼摘要</summary>';
    const ABS_BLOCK_RE = /<details data-mp-abs="1">[\s\S]*?<\/details>/;
    const ABS_AUTO_WINDOW = 6;   // 自动模式只看最近这几楼；老楼交给手动补漏（防止旧长档一开开关就失控烧token）
    const ABS_AUTO_LIMIT = 2;    // 每次落楼最多自动补几楼
    const ABS_MANUAL_LIMIT = 10; // 手动补漏每次最多几楼（一楼十几秒，再多前台挂太久）

    // [MP] 默认摘要提示词。vault.html 里有一份同文案的展示副本(DEFAULT_ABS_PROMPT)，改这里必须同步改那边！
    const ABS_DEFAULT_PROMPT =
        '你是长篇小说的剧情档案员。「用户输入」是小说的一楼正文（可能附带【背景参考·作者输入】）。' +
        '唯一任务：为【本楼正文】写一段80~160字的剧情摘要，只输出 <mpabs>摘要正文</mpabs>，标签外一个字都不写。\n' +
        '【要求】\n' +
        '1. 只概括【本楼正文】里发生的事；背景参考仅用于理解，不得写进摘要。\n' +
        '2. 客观第三人称叙事体；人物一律用原文原名称呼，禁止出现「你」「我」这类称呼。\n' +
        '3. 必留：具体行动与结果、关键对话的核心内容、人物关系或情绪的实质变化、时间地点变动、重要物品的出现与转移。\n' +
        '4. 剔除：景物渲染、修辞、逐句对白、无实质推进的往来。\n' +
        '5. 亲密与成人情节同样是剧情事实，照实概括到具体行为与关系进展，不回避不含糊。\n' +
        '6. 摘要是一段纯文本，不用列表、标题、加粗，不带任何解释或前后缀。';

    function absHas(text) { return ABS_BLOCK_RE.test(String(text || '')); }
    function absStrip(text) {
        return String(text || '').replace(new RegExp(ABS_BLOCK_RE.source, 'g'), '').replace(/\n+$/, '');
    }
    async function absEnabled() { return !!(await rpgGetVaultSetting('absEnabled', false)); }
    async function absPrompt() {
        const p = await rpgGetVaultSetting('absPrompt', '');
        return (typeof p === 'string' && p.trim()) ? p : ABS_DEFAULT_PROMPT;
    }
    function absToast(t) {
        try { if (window.toastr) { window.toastr.info(t, '摘要线'); return; } } catch (e) { }
        console.log(TAG, '[摘要]', t);
    }

    // [MP] 自动安装「近楼看全文/远楼只看摘要」正则对（Miel 2026-08-06 拍板：桥自动装）。
    //   装进酒馆正则扩展的全局脚本列表（extension_settings.regex，用户配置数据，不碰任何代码）。
    //   幂等：按固定 id / 脚本名查重，已存在就一根手指都不动——Miel 在酒馆正则界面手调过的
    //   深度、开关、内容全都保得住。想停掉送递就在酒馆正则里禁用这两条（那是送递的总开关）；
    //   蜜脾设置里的开关只管「还生成不生成新摘要」。
    //   深度语义（照抄酒馆引擎）：depth=从最后一条可见消息往回数，0=最新。默认近10条(0~9)看全文，10条开外只看摘要。
    async function absInstallRegex() {
        try {
            await loadRegexEngine();
            if (!regexEngine || !regexEngine.regex_placement) return;
            const c = ctx();
            const es = c && c.extensionSettings;
            if (!es) return;
            if (!Array.isArray(es.regex)) es.regex = [];
            const AI = regexEngine.regex_placement.AI_OUTPUT;
            // 字段形状照抄酒馆正则扩展 index.js 的新建脚本模板（2026-08-06 对过真源码）
            const mk = function (id, name, find, rep, minD, maxD) {
                return {
                    id: id, scriptName: name, findRegex: find, replaceString: rep, trimStrings: [],
                    placement: [AI], disabled: false, markdownOnly: false, promptOnly: true,
                    runOnEdit: false, substituteRegex: 0, minDepth: minD, maxDepth: maxD,
                };
            };
            const defs = [
                mk('mp-abs-near', '【蜜脾】近楼藏摘要块',
                    '/\\n*<details data-mp-abs="1"><summary>本楼摘要<\\/summary>\\n?[\\s\\S]*?\\n?<\\/details>/',
                    '', null, 9),
                mk('mp-abs-far', '【蜜脾】远楼只留摘要',
                    '/^[\\s\\S]*<details data-mp-abs="1"><summary>本楼摘要<\\/summary>\\n?([\\s\\S]*?)\\n?<\\/details>[\\s\\S]*$/',
                    '【本楼梗概】$1', 10, null),
            ];
            let added = 0;
            defs.forEach(function (d) {
                if (!es.regex.some(function (s) { return s && (s.id === d.id || s.scriptName === d.scriptName); })) {
                    es.regex.push(d); added++;
                }
            });
            if (added) {
                if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
                absToast('已装入摘要送递正则×' + added + '（在酒馆正则列表里，两条【蜜脾】脚本）');
            }
        } catch (e) {
            try { send('bridge-debug', { message: '[摘要] 送递正则自动安装失败：' + String(e && e.message || e) }); } catch (e2) { }
        }
    }

    // [MP] 摘要原料 = 前置的连续作者楼（背景参考）＋ 本楼正文，全走净版；剥掉本模块自己的折叠块防自嵌套。
    //   ★净版一律按 depth=0（近楼视角）洗（Miel 2026-08-06拍板：副API必须永远读完整原文写摘要）：
    //   清杂物的正则照常生效，但「远楼只留摘要」这类按深度删正文的规则一概不生效——
    //   否则补漏补到远处老楼时，副API读到的是被削成摘要的残版，等于照着摘要写摘要。
    //   注意不能不传 depth：引擎源码（regex/engine.js getRegexedString）里 depth 非数字时
    //   深度过滤整个跳过、带深度限制的脚本全都会跑，必须显式传 0 才是「近楼视角」。
    function absBuildSrc(floorIdx) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const parts = [];
        let u = floorIdx - 1;
        const userParts = [];
        while (u >= 0 && chat[u] && chat[u].is_user) {
            userParts.unshift(cleanOne(chat[u].mes || '', true, 0));
            u--;
        }
        if (userParts.length) parts.push('【背景参考·作者输入】\n' + userParts.join('\n'));
        const m = chat[floorIdx];
        parts.push('【本楼正文】\n' + absStrip(cleanOne(m.mes || '', false, 0)));
        return parts.join('\n\n');
    }

    // [MP] 抠出回复里最后一个 <mpabs>；没包标签但整体像一段摘要也认（宽进）。
    //   摘要必须是纯文本：剥掉一切标签，防止里面混进 </details> 之类把折叠块和送递正则打断。
    function absParseReply(text) {
        const s = String(text || '').replace(/<think(?:ing)?[\s>][\s\S]*?<\/think(?:ing)?>/gi, '');
        let body = null;
        const ms = Array.from(s.matchAll(/<mpabs>([\s\S]*?)<\/mpabs>/gi));
        if (ms.length) body = ms[ms.length - 1][1];
        else { const t = s.trim(); if (t && t.length <= 1000) body = t; }
        if (!body) return null;
        body = body.replace(/<[^>]*>/g, '').trim();
        return body || null;
    }

    // [MP] 给一楼出摘要并写回折叠块。收尾时现场重验：请求期间换了对话/重骰/改了字，结果直接扔（标脏即弃）。
    async function absSettleFloor(chatKey, floorIdx) {
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const m = chat[floorIdx];
        if (!m || m.is_user || m.is_system) return false;
        const raw = String(m.mes || '');
        if (!raw.trim() || raw === '...') return false;
        if (absHas(raw)) return false;                    // 已有摘要
        if (SUMMARY_TAG_RE.test(raw)) return false;       // 卷总结楼不配摘要（它本身就是摘要）
        await loadRegexEngine();
        const reply = await rpgCallSubApi(await absPrompt(), absBuildSrc(floorIdx));
        const abs = absParseReply(reply);
        if (!abs) throw new Error(floorIdx + '楼：副API回复里没有摘要');
        if (currentChatKey() !== chatKey) return false;
        const c2 = ctx();
        const chat2 = (c2 && Array.isArray(c2.chat)) ? c2.chat : [];
        const m2 = chat2[floorIdx];
        if (!m2 || String(m2.mes || '') !== raw) return false;   // 请求期间被重骰/改过 → 过期货，扔
        m2.mes = raw + '\n\n' + ABS_BLOCK_START + '\n' + abs + '\n</details>';
        ensureSwipesLocal(m2);   // 把新正文对齐进当前 swipe 槽（摘要跟着这一版走）
        if (m2.extra) delete m2.extra.token_count;
        if (typeof c2.updateMessageBlock === 'function') {
            try { c2.updateMessageBlock(floorIdx, m2); } catch (e) { }
        }
        return true;
    }

    // [MP] 跑一批楼。同时只跑一发；每楼串行（副API本来就一次一发）；成了才落盘。
    let absRunning = false;
    async function absRunBatch(todo, chatKey, manual) {
        if (absRunning) return 0;
        absRunning = true;
        let ok = 0;
        try {
            for (const f of todo) {
                if (currentChatKey() !== chatKey) break;   // 中途切了对话就停
                if (await absSettleFloor(chatKey, f)) {
                    ok++;
                    if (manual) absToast(f + '楼摘要好了（' + ok + '/' + todo.length + '）');
                }
            }
        } catch (e) {
            const msg = String(e && e.message || e);
            absToast('摘要失败：' + msg);
            try { send('bridge-debug', { message: '[摘要] ' + msg }); } catch (e2) { }
        } finally {
            absRunning = false;
        }
        if (ok) {
            try {
                const c = ctx();
                const save = (c && (c.saveChat || c.saveChatConditional)) || null;
                if (typeof save === 'function') await save();
            } catch (e) {
                absToast('摘要已写进楼里但写盘失败：' + String(e && e.message || e));
                try { send('bridge-debug', { message: '[摘要] 写盘失败：' + String(e && e.message || e) }); } catch (e2) { }
            }
            try { send('chat-dirty'); } catch (e) { }   // 正文变了，蜜脾那边好刷新
        }
        return ok;
    }

    // [MP] 自动挡：落楼后补最近几楼里缺摘要的（窗口内从旧到新，跑不完下次落楼接着跑）
    async function absAuto() {
        if (absRunning) return;
        if (!(await absEnabled())) return;
        const chatKey = currentChatKey();
        if (!chatKey) return;
        await absInstallRegex();   // 幂等，首次真装，之后查一眼就走
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const todo = [];
        for (let i = Math.max(0, chat.length - ABS_AUTO_WINDOW); i < chat.length; i++) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && String(m.mes || '').trim() && String(m.mes) !== '...'
                && !absHas(m.mes) && !SUMMARY_TAG_RE.test(m.mes)) todo.push(i);
            if (todo.length >= ABS_AUTO_LIMIT) break;
        }
        if (todo.length) await absRunBatch(todo, chatKey, false);
    }

    // [MP] 手动挡（魔棒菜单「摘要补漏」）：全书扫一遍缺摘要的楼，从最早的开始补，一次最多一批。
    //   为什么按钮在酒馆里而不是蜜脾里：写回折叠块必须动酒馆内存里的 chat 数组，而蜜脾在前台时
    //   酒馆标签会被手机冻死——补漏必须在酒馆自己前台的时候跑，按钮就得长在酒馆里。
    async function absCatchupManual() {
        if (absRunning) { absToast('摘要正在跑，稍等再点'); return; }
        if (!(await absEnabled())) { absToast('摘要线没开：去蜜脾→副API设置里打开「每楼摘要」'); return; }
        const chatKey = currentChatKey();
        if (!chatKey) { absToast('先打开一个对话'); return; }
        await absInstallRegex();
        const c = ctx();
        const chat = (c && Array.isArray(c.chat)) ? c.chat : [];
        const missing = [];
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && String(m.mes || '').trim() && String(m.mes) !== '...'
                && !absHas(m.mes) && !SUMMARY_TAG_RE.test(m.mes)) missing.push(i);
        }
        if (!missing.length) { absToast('全部楼层都有摘要了'); return; }
        const n = Math.min(ABS_MANUAL_LIMIT, missing.length);
        if (!window.confirm('缺摘要 ' + missing.length + ' 楼。本次补最早的 ' + n + ' 楼？\n（一楼约十几秒，补漏期间请停在酒馆页别切走）')) return;
        const done = await absRunBatch(missing.slice(0, n), chatKey, true);
        const left = missing.length - (done || 0);
        absToast('本次补好 ' + (done || 0) + ' 楼' + (left > 0 ? ('，还缺 ' + left + ' 楼，再点一次继续') : '，全齐了'));
    }

    // [MP] 魔棒菜单入口
    function absAddWandButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) { setTimeout(absAddWandButton, 800); return; }
        if (document.getElementById('mp_abs_wand')) return;
        const btn = document.createElement('div');
        btn.id = 'mp_abs_wand';
        btn.className = 'list-group-item flex-container flexGap5 interactable';
        btn.tabIndex = 0;
        btn.innerHTML = '<div class="fa-solid fa-file-lines extensionsMenuExtensionButton"></div><span>摘要补漏</span>';
        btn.addEventListener('click', function () {
            absCatchupManual().catch(function (e) { absToast('补漏出错：' + (e && e.message || e)); });
        });
        menu.appendChild(btn);
    }

    // [MP] 事件接线：自带重试，独立一套（不搅正文快照那套，也不搅养成线）
    function wireAbsEvents() {
        const c = ctx();
        if (!c || !c.eventSource || !c.eventTypes) { setTimeout(wireAbsEvents, 300); return; }
        const es = c.eventSource, et = c.eventTypes;
        if (et.MESSAGE_RECEIVED) es.on(et.MESSAGE_RECEIVED, function () {
            // [MP] 稍等一拍让楼落稳、净版能算；1500ms 也错开养成线的 900ms，两条线都开时别挤同一瞬间
            setTimeout(function () {
                absAuto().catch(function (e) {
                    try { send('bridge-debug', { message: '[摘要] 自动摘要失败：' + String(e && e.message || e) }); } catch (e2) { }
                });
            }, 1500);
        });
        // 重骰/删楼不用管账：摘要住在正文里，跟着版本走，天生一致
    }

    function absInit() {
        absAddWandButton();
        setTimeout(absAddWandButton, 2500);
        wireAbsEvents();
        // [MP] 开关已开的话，页面一加载就把两条送递正则装好，不用等第一楼落地
        setTimeout(function () {
            absEnabled().then(function (on) {
                if (on) return absInstallRegex();
            }).catch(function (e) {
                try { send('bridge-debug', { message: '[摘要] 开机装正则失败：' + String(e && e.message || e) }); } catch (e2) { }
            });
        }, 2000);
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
    rpgInit();
    absInit();
})();
