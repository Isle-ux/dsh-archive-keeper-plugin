/**
 * dsh-archive-keeper — 浏览器半边（挂在每个对话头部的工具条上）。
 *
 * 座位：`conversation.session.header.utilities`（list-kind, scope: session），
 * 也就是对话头部右侧那排工具按钮，**每个对话都有**。
 *
 * 历史（避免再放错）：最初用户口径是「把新功能做到工作区的视图选项里」，
 * 即侧栏工作区头部「视图选项 / 添加工作区」之间。但查证源码后确认：
 * ui-workspace 的那两个按钮是写死的数组（`headerActions` 里 ViewOptionsMenu
 * 紧接 add-workspace 按钮），中间没有插槽；ui-workspace 总共只声明 6 个槽，
 * 没有一个是工作区头部那一行。所以改挂到对话头部工具条。
 *
 * 契约要点：
 *   - 本座位 owner props 是 `children?: never`，组件拿不到宿主传值，
 *     必须自带数据源（本插件自己 fetch 同源路由 /archive-keeper/*）。
 *   - 必须导出 `apply` + `inject`，且不能导出 `default`。
 *   - 只在桌面版 / 网页版这种有对话区的宿主里存在；其它宿主（headless 等）
 *     本座位不存在，inject 回调不跑，插件自然不激活——即「只做桌面版」。
 *   - 本文件必须保持浏览器安全：无 import / require / Node API，只从 factory 取 React。
 *
 * 选项模型（两选项，2026-10-03 收敛）：
 *   keepBoth    —— 保留原文：什么都不删，归入「已保留·原文在」。
 *   keepSummary —— 只留摘要：保留摘要，原文移入回收站，归入「已保留·已精简」，
 *                  可随时「恢复原文」（回收站没清空就能恢复）。
 *
 * 数据来自宿主同源路由 /archive-keeper/*（见 lib/index.js）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-archive-keeper',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const VIEW_ID = 'archive-keeper';
    const BASE = '/archive-keeper';

    const T = {
      view: '归档守护',
      loading: '加载中…',
      empty: '还没有提炼过任何归档会话。',
      refresh: '刷新',
      rerun: '重新提炼',
      rerunning: '提炼中…',
      rerunStarted: '已开始提炼…',
      rerunAlready: '已有提炼正在进行，请稍候…',
      rerunFailed: '无法启动提炼',
      pending: '待提炼',
      // 两个选项
      keepBoth: '保留原文',
      keepSummary: '只留摘要',
      keepBothHint: '原文一直保留，什么都不删。之后想精简，可在「已保留」里再选「只留摘要」。',
      keepSummaryHint: '保留摘要，原文移入回收站。之后可在「已保留」里「恢复原文」。',
      // 恢复
      restore: '恢复原文',
      restoring: '恢复中…',
      restored: '原文已恢复',
      restoreFail: '恢复失败',
      // 彻底删除 / 已删除
      hardDelete: '彻底删除',
      hardDeleting: '删除中…',
      hardDeleteHint: '原文和摘要一起移入回收站，进入「已删除」。之后可恢复。',
      confirmHardDelete: '确定彻底删除？原文与摘要都会移入回收站，之后可从「已删除」恢复。',
      restoreDeleted: '恢复',
      restoredTo: '已恢复',
      stDeleted: '已删除',
      filterDeleted: '已删除',
      deletedEmpty: '「已删除」里还没有内容。',
      prevWas: '删除前',
      restoredToState: '已恢复到',
      // 状态
      stOriginal: '原文在',
      stSlim: '已精简',
      stLost: '原文已丢失',
      reusable: '值得留存',
      disposable: '可丢弃',
      archivedTotal: '归档总数',
      processed: '已提炼',
      errLoad: '读取失败',
      errDecide: '操作失败',
      keyPoints: '要点',
      decisions: '决定',
      facts: '事实',
      deliverables: '交付物',
      openThreads: '待办',
      obsolete: '已作废',
      userTurns: '轮',
      // 筛选
      filterAll: '全部',
      filterTodo: '待决定',
      filterKept: '已保留',
      filterOriginal: '原文在',
      filterSlim: '已精简',
      filterDeleted: '已删除',
      filterReusable: '值得留存',
      // 回收站
      trash: '回收站',
      trashEmpty: '回收站是空的。',
      trashCount: '份',
      emptyTrash: '清空回收站',
      emptying: '清理中…',
      trashWarn: '以下内容将被永久删除，不可恢复：',
      trashConfirm: '确认永久删除',
      trashCancel: '取消',
      trashed: '已永久删除',
      // 折叠
      expandAll: '全部展开',
      collapseAll: '全部折叠',
      confirmSlim: '确定只留摘要？原文会移入回收站（可恢复）。',
      confirm: '确定',
      cancel: '取消',
      decidedHint: '已选择',

      // ── 自定义价值（值得留存的齿轮）──
      gear: '自定义价值',
      gearTitle: '自定义「值得留存」的价值判断',
      gearLead: '你定义的规则是「值得留存」的首要判断：命中就优先收纳。没命中任何规则的，才回落到默认价值判断（我提炼时给出的 reusable）。',
      gearNoCustom: '目前没有自定义规则，完全按默认价值判断收纳。',
      tabTags: '标签',
      tabRules: '收纳规则',
      tabAuto: '自动打标签',
      tagPool: '我的标签',
      tagPresets: '常见标签（点一下加入）',
      tagNew: '新建标签',
      tagNamePh: '标签名',
      tagAdd: '加入',
      tagDelete: '删除标签',
      confirmDeleteTag: '删除这个标签？所有会话上的该标签会一起移除，规则里引用它的也会被清空。',
      tagEmpty: '还没有标签。可以从下面的常见标签里挑，或自己新建。',
      ruleNew: '新建规则',
      ruleEmpty: '还没有规则。',
      ruleKeywords: '关键词（用逗号分隔，命中任一）',
      ruleKeywordsPh: '例如：插件, DSH, 归档',
      ruleCategories: '分类（命中任一）',
      ruleTurns: '用户轮数',
      ruleMinTurns: '最少轮数',
      ruleMaxTurns: '最多轮数',
      ruleTag: '同时打上标签（可选）',
      ruleNoTag: '（不打标签）',
      ruleNote: '备注（可选）',
      ruleNotePh: '这条规则是干什么的',
      ruleSave: '保存规则',
      ruleCancel: '取消',
      ruleEnable: '启用',
      ruleDisable: '停用',
      ruleEnabled: '启用中',
      ruleDisabled: '已停用',
      ruleDelete: '删除规则',
      ruleFirstPriority: '首要判断',
      ruleNeedsCondition: '至少要填一个条件（关键词或分类），否则会命中所有对话。',
      autoHint: '自动打标签只影响标签，不改变收纳 —— 收纳请用「收纳规则」。',
      keepByCustom: '规则收纳',
      keepByDefault: '默认收纳',
      customBadge: '个性',

      // ── 时间段分组 ──
      periodMorning: '上午',
      periodAfternoon: '下午',
      periodEvening: '晚上',
      untagged: '未分类',
    };

    const CATEGORY_LABEL = {
      decision: '决定',
      preference: '偏好',
      fact: '事实',
      lesson: '教训',
      deliverable: '交付',
      todo: '待办',
      trivial: '琐碎',
    };

    const CSS = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13, lineHeight: 1.6, overflow: 'hidden' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,0.25))', flex: '0 0 auto', flexWrap: 'wrap' },
      btn: { cursor: 'pointer', border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontFamily: 'inherit' },
      activeBtn: { cursor: 'pointer', border: '1px solid var(--dsh-accent, rgba(120,170,255,0.8))', background: 'rgba(120,170,255,0.16)', color: 'inherit', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontFamily: 'inherit' },
      primaryBtn: { cursor: 'pointer', border: '1px solid var(--dsh-accent, rgba(120,170,255,0.8))', background: 'rgba(120,170,255,0.2)', color: 'inherit', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', fontWeight: 600 },
      danger: { cursor: 'pointer', border: '1px solid rgba(220,80,80,0.65)', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontFamily: 'inherit' },
      list: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '10px 14px' },
      card: { border: '1px solid var(--dsh-border, rgba(128,128,128,0.22))', borderRadius: 10, marginBottom: 8, background: 'var(--dsh-surface, rgba(128,128,128,0.045))', overflow: 'hidden' },
      // 折叠标题行：整行可点
      cardHead: { display: 'flex', gap: 8, alignItems: 'center', padding: '9px 12px', cursor: 'pointer', userSelect: 'none' },
      caret: { flex: '0 0 auto', width: 12, opacity: 0.65, fontSize: 11 },
      cardTitle: { fontWeight: 600, flex: '1 1 auto', wordBreak: 'break-word', minWidth: 0 },
      cardBody: { padding: '0 12px 12px', borderTop: '1px solid var(--dsh-border, rgba(128,128,128,0.15))', paddingTop: 10 },
      tag: { flex: '0 0 auto', fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', opacity: 0.85, whiteSpace: 'nowrap' },
      tagOk: { flex: '0 0 auto', fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(90,180,110,0.6)', opacity: 0.95, whiteSpace: 'nowrap' },
      tagWarn: { flex: '0 0 auto', fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(220,160,60,0.6)', opacity: 0.95, whiteSpace: 'nowrap' },
      summary: { opacity: 0.92, marginBottom: 6, wordBreak: 'break-word' },
      secTitle: { fontWeight: 600, opacity: 0.7, fontSize: 12, marginTop: 6 },
      ul: { margin: '2px 0 0', paddingLeft: 18 },
      li: { marginBottom: 2, wordBreak: 'break-word' },
      actions: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' },
      muted: { opacity: 0.6 },
      hint: { fontSize: 11, opacity: 0.65, marginBottom: 6 },
      optBox: { border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))', borderRadius: 8, padding: 10, marginTop: 8 },
      optTitle: { fontWeight: 600, marginBottom: 2 },
      trashBox: { border: '1px solid rgba(220,80,80,0.45)', borderRadius: 8, padding: 10, margin: '0 0 10px' },

      trigger: { display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
      popover: { position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, width: 480, maxWidth: '92vw', maxHeight: '72vh', overflowY: 'auto', padding: 12, borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'var(--dsh-bg-elevated, var(--dsh-bg, #1e1f22))', boxShadow: '0 8px 28px rgba(0,0,0,0.35)', textAlign: 'left' },
      badge: { display: 'inline-block', minWidth: 16, marginLeft: 4, padding: '0 4px', fontSize: 10, lineHeight: '14px', textAlign: 'center', borderRadius: 7, border: '1px solid rgba(220,160,60,0.7)', opacity: 0.95 },

      // ── 自定义价值面板 ──
      gearBtn: { cursor: 'pointer', border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '3px 7px', fontSize: 13, lineHeight: 1, fontFamily: 'inherit' },
      gearBtnOn: { cursor: 'pointer', border: '1px solid var(--dsh-accent, rgba(120,170,255,0.8))', background: 'rgba(120,170,255,0.16)', color: 'inherit', borderRadius: 6, padding: '3px 7px', fontSize: 13, lineHeight: 1, fontFamily: 'inherit' },
      gearPanel: { border: '1px solid var(--dsh-accent, rgba(120,170,255,0.45))', borderRadius: 8, padding: 12, margin: '0 0 10px', background: 'rgba(120,170,255,0.06)' },
      gearLead: { fontSize: 12, opacity: 0.8, marginBottom: 8, lineHeight: 1.6 },
      tabRow: { display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 },
      label: { fontSize: 11, opacity: 0.7 },
      input: { border: '1px solid var(--dsh-border, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit', minWidth: 0, width: '100%', boxSizing: 'border-box' },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' },
      chipWrap: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 7px', borderRadius: 10, border: '1px solid var(--dsh-border, rgba(128,128,128,0.4))', cursor: 'pointer', whiteSpace: 'nowrap' },
      chipOn: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 7px', borderRadius: 10, border: '1px solid rgba(120,170,255,0.85)', background: 'rgba(120,170,255,0.18)', cursor: 'pointer', whiteSpace: 'nowrap' },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      ruleCard: { border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))', borderRadius: 8, padding: 9, marginBottom: 7 },
      ruleOff: { border: '1px solid var(--dsh-border, rgba(128,128,128,0.2))', borderRadius: 8, padding: 9, marginBottom: 7, opacity: 0.55 },
      catRow: { display: 'flex', gap: 5, flexWrap: 'wrap' },

      // ── 筛选栏：「已保留」的分隔与子界面 ──
      sep: { display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 4, marginLeft: 2, borderLeft: '1px solid var(--dsh-border, rgba(128,128,128,0.3))' },
      // 「已保留」的子界面：独立一层，绝对定位在筛选栏下方，盖在内容之上，
      // 完全不影响筛选栏原有布局。
      subPlane: {
        position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 6,
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '8px 10px', borderRadius: 8,
        background: 'var(--dsh-bg-elevated, rgba(28,30,36,0.98))',
        border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      },
      subPlaneTitle: { fontSize: 11, opacity: 0.65, marginRight: 2 },

      // ── 四级分组头：年份 → 日期 → 时段 → 标签 ──
      // 越靠上层级越醒目；日期与时段是「时间段分类」，按要求加粗加大。
      yearHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '22px 0 10px', paddingBottom: 6, borderBottom: '3px double var(--dsh-accent, rgba(120,170,255,0.75))' },
      yearHeadFirst: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '2px 0 10px', paddingBottom: 6, borderBottom: '3px double var(--dsh-accent, rgba(120,170,255,0.75))' },
      yearText: { fontSize: 20, fontWeight: 700, letterSpacing: 0.5 },
      timeHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '16px 0 8px', paddingBottom: 5, borderBottom: '2px solid var(--dsh-accent, rgba(120,170,255,0.5))' },
      timeHeadFirst: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', margin: '8px 0 8px', paddingBottom: 5, borderBottom: '2px solid var(--dsh-accent, rgba(120,170,255,0.5))' },
      timeDate: { fontSize: 17, fontWeight: 700, letterSpacing: 0.3 },
      timePeriod: { fontSize: 16, fontWeight: 700, color: 'var(--dsh-accent, rgba(120,170,255,1))' },
      periodRow: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '12px 0 6px', paddingLeft: 2 },
      timeCount: { fontSize: 11, fontWeight: 400, opacity: 0.6 },
      // 标签细分（比时间头轻，但仍成组）
      labelHead: { display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 6px', fontWeight: 600, fontSize: 12.5, opacity: 0.9 },
      labelBar: { width: 3, height: 13, borderRadius: 2, flex: '0 0 auto' },
      labelCount: { fontSize: 11, fontWeight: 400, opacity: 0.6, marginLeft: 2 },
    };

    // ── 数据访问 ────────────────────────────────────────────────────────
    async function fetchList() {
      const r = await fetch(`${BASE}/list`, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    async function postJson(p, body) {
      const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }
    const postDecide = (id, decision) => postJson(`${BASE}/decide`, { id, decision });
    const postRestore = (id) => postJson(`${BASE}/restore`, { id });
    const postHardDelete = (id) => postJson(`${BASE}/hard-delete`, { id });
    const postRestoreDeleted = (id) => postJson(`${BASE}/restore-deleted`, { id });
    const postTag = (payload) => postJson(`${BASE}/tag`, payload);
    const postRule = (payload) => postJson(`${BASE}/rule`, payload);
    const postRun = () => postJson(`${BASE}/run`, { all: false });
    const postEmptyTrash = (ids) => postJson(`${BASE}/empty-trash`, { confirm: true, ids });

    function fmtSize(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    function fmtDate(ms) {
      if (!ms) return '';
      try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
    }

    // ── 自定义价值面板（「值得留存」的齿轮）────────────────────────────────
    // 语义：这里定的规则是「值得留存」的**首要**判断；没命中任何规则的才走默认判断。
    function CustomizePanel({ data, load, tab, setTab }) {
      const cust = (data && data.customization) || { available: false, tags: [], auto: [], rules: [], presets: { tags: [], categories: [] } };
      const [newTag, setNewTag] = React.useState('');
      const [err, setErr] = React.useState(null);
      const [busyKey, setBusyKey] = React.useState(null);

      // 新建规则的表单
      const [draft, setDraft] = React.useState({ keywords: '', categories: [], minTurns: '', maxTurns: '', tag: '', note: '' });

      const act = async (key, fn) => {
        setBusyKey(key);
        setErr(null);
        try {
          const r = await fn();
          if (r && r.ok === false) setErr(r.error || '操作失败');
          await load();
        } catch (e) {
          setErr(String(e?.message || e));
        } finally {
          setBusyKey(null);
        }
      };

      const addTag = (name, color, note) =>
        act('tag:' + name, () => postTag({ action: 'add', name, color, note }));

      const delTag = (name) => {
        if (!window.confirm(T.confirmDeleteTag)) return;
        return act('deltag:' + name, () => postTag({ action: 'remove', name }));
      };

      const saveRule = (kind) => {
        const kw = draft.keywords.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
        const match = {};
        if (kw.length) match.keywords = kw;
        if (draft.categories.length) match.categories = draft.categories;
        if (draft.minTurns !== '' && !Number.isNaN(Number(draft.minTurns))) match.minTurns = Number(draft.minTurns);
        if (draft.maxTurns !== '' && !Number.isNaN(Number(draft.maxTurns))) match.maxTurns = Number(draft.maxTurns);
        if (!Object.keys(match).length) {
          setErr(T.ruleNeedsCondition);
          return;
        }
        return act('newrule', () =>
          postRule({ action: 'add', kind, rule: { match, tag: draft.tag || null, note: draft.note } }),
        ).then(() => setDraft({ keywords: '', categories: [], minTurns: '', maxTurns: '', tag: '', note: '' }));
      };

      const tagColor = (name) => (cust.tags.find((t) => t.name === name) || {}).color || '#6b7280';

      const describe = (m) => {
        const x = m || {};
        const p = [];
        if (Array.isArray(x.keywords) && x.keywords.length) p.push(`关键词：${x.keywords.join(' / ')}`);
        if (Array.isArray(x.categories) && x.categories.length) p.push(`分类：${x.categories.map((c) => CATEGORY_LABEL[c] || c).join(' / ')}`);
        if (typeof x.minTurns === 'number') p.push(`≥ ${x.minTurns} 轮`);
        if (typeof x.maxTurns === 'number') p.push(`≤ ${x.maxTurns} 轮`);
        return p.length ? p.join('，') : '（无条件）';
      };

      if (!cust.available) {
        return h('div', { style: CSS.gearPanel }, h('div', { style: CSS.muted }, '自定义规则模块（tags.cjs）未加载，暂时不可用。'));
      }

      // ── 标签页 ──
      const tagsTab = h('div', null,
        cust.hasCustom
          ? null
          : h('div', { style: { ...CSS.muted, fontSize: 12, marginBottom: 8 } }, T.gearNoCustom),
        h('div', { style: CSS.label }, T.tagPool),
        !cust.tags.length
          ? h('div', { style: { ...CSS.muted, fontSize: 12, marginBottom: 8 } }, T.tagEmpty)
          : h('div', { style: CSS.chipWrap },
              ...cust.tags.map((t) =>
                h('span', { key: t.name, style: CSS.chip, title: t.note || '' },
                  h('span', { style: { ...CSS.dot, background: t.color } }),
                  t.name,
                  h('span', { style: { ...CSS.muted, cursor: 'pointer', marginLeft: 2 }, onClick: () => delTag(t.name) }, '×'),
                ),
              ),
            ),
        h('div', { style: CSS.label }, T.tagPresets),
        h('div', { style: CSS.chipWrap },
          ...cust.presets.tags
            .filter((p) => !cust.tags.some((t) => t.name === p.name))
            .map((p) =>
              h('span', {
                key: p.name,
                style: { ...CSS.chip, opacity: busyKey === 'tag:' + p.name ? 0.5 : 1 },
                title: p.note,
                onClick: () => addTag(p.name, p.color, p.note),
              }, h('span', { style: { ...CSS.dot, background: p.color } }), p.name, ' ＋'),
            ),
          cust.presets.tags.every((p) => cust.tags.some((t) => t.name === p.name))
            ? h('span', { style: { ...CSS.muted, fontSize: 11 } }, '预设标签都加完了。')
            : null,
        ),
        h('div', { style: { ...CSS.row, marginTop: 10 } },
          h('input', {
            style: { ...CSS.input, flex: '1 1 160px', width: 'auto' },
            placeholder: T.tagNamePh,
            value: newTag,
            onChange: (e) => setNewTag(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && newTag.trim()) { addTag(newTag.trim()); setNewTag(''); } },
          }),
          h('button', {
            style: CSS.primaryBtn,
            disabled: !newTag.trim(),
            onClick: () => { addTag(newTag.trim()); setNewTag(''); },
          }, T.tagAdd),
        ),
        h('div', { style: { ...CSS.muted, fontSize: 11, marginTop: 6 } },
          '加好标签后，到「收纳规则」里用它，或直接点某个对话里的「标签」按钮手工打。'),
      );

      // ── 规则表单（收纳规则 / 自动打标签共用）──
      const ruleForm = (kind) =>
        h('div', { style: { ...CSS.ruleCard, marginTop: 8, background: 'rgba(128,128,128,0.05)' } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, kind === 'rules' ? T.ruleNew : T.tabAuto),
          h('div', { style: CSS.field },
            h('span', { style: CSS.label }, T.ruleKeywords),
            h('input', {
              style: CSS.input,
              placeholder: T.ruleKeywordsPh,
              value: draft.keywords,
              onChange: (e) => setDraft({ ...draft, keywords: e.target.value }),
            }),
          ),
          h('div', { style: CSS.field },
            h('span', { style: CSS.label }, T.ruleCategories),
            h('div', { style: CSS.catRow },
              ...cust.presets.categories.map((c) => {
                const on = draft.categories.includes(c);
                return h('span', {
                  key: c,
                  style: on ? CSS.chipOn : CSS.chip,
                  onClick: () =>
                    setDraft({ ...draft, categories: on ? draft.categories.filter((x) => x !== c) : [...draft.categories, c] }),
                }, CATEGORY_LABEL[c] || c);
              }),
            ),
          ),
          h('div', { style: CSS.row },
            h('div', { style: { ...CSS.field, flex: '1 1 100px' } },
              h('span', { style: CSS.label }, T.ruleMinTurns),
              h('input', { style: CSS.input, type: 'number', value: draft.minTurns, onChange: (e) => setDraft({ ...draft, minTurns: e.target.value }) }),
            ),
            h('div', { style: { ...CSS.field, flex: '1 1 100px' } },
              h('span', { style: CSS.label }, T.ruleMaxTurns),
              h('input', { style: CSS.input, type: 'number', value: draft.maxTurns, onChange: (e) => setDraft({ ...draft, maxTurns: e.target.value }) }),
            ),
            h('div', { style: { ...CSS.field, flex: '1 1 140px' } },
              h('span', { style: CSS.label }, T.ruleTag),
              h('select', {
                style: CSS.input,
                value: draft.tag,
                onChange: (e) => setDraft({ ...draft, tag: e.target.value }),
              },
                h('option', { value: '' }, T.ruleNoTag),
                ...cust.tags.map((t) => h('option', { key: t.name, value: t.name }, t.name)),
              ),
            ),
          ),
          h('div', { style: CSS.field },
            h('span', { style: CSS.label }, T.ruleNote),
            h('input', { style: CSS.input, placeholder: T.ruleNotePh, value: draft.note, onChange: (e) => setDraft({ ...draft, note: e.target.value }) }),
          ),
          h('button', { style: CSS.primaryBtn, disabled: busyKey === 'newrule', onClick: () => saveRule(kind) }, T.ruleSave),
        );

      const ruleList = (kind) => {
        const list = cust[kind] || [];
        return h('div', null,
          cust.hasCustom
            ? null
            : h('div', { style: { ...CSS.muted, fontSize: 12, marginBottom: 8 } }, T.gearNoCustom),
          kind === 'auto' ? h('div', { style: { ...CSS.muted, fontSize: 12, marginBottom: 8 } }, T.autoHint) : null,
          kind === 'rules'
            ? h('div', { style: { fontSize: 12, marginBottom: 8, opacity: 0.85 } },
                h('b', null, T.ruleFirstPriority), '：命中即优先纳入「值得留存」，优先于默认判断。')
            : null,
          !list.length ? h('div', { style: { ...CSS.muted, fontSize: 12, marginBottom: 8 } }, T.ruleEmpty) : null,
          ...list.map((r) =>
            h('div', { key: r.id, style: r.enabled === false ? CSS.ruleOff : CSS.ruleCard },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: 600, fontSize: 12 } }, describe(r.match)),
                r.tag
                  ? h('span', { style: { ...CSS.chip, cursor: 'default' } },
                      h('span', { style: { ...CSS.dot, background: tagColor(r.tag) } }), `打标签：${r.tag}`)
                  : null,
                h('span', { style: { flex: '1 1 auto' } }),
                h('span', { style: { ...CSS.muted, fontSize: 11 } }, r.enabled === false ? T.ruleDisabled : T.ruleEnabled),
                h('button', {
                  style: CSS.btn,
                  onClick: () => act('tog:' + r.id, () => postRule({ action: 'update', id: r.id, patch: { enabled: r.enabled === false } })),
                }, r.enabled === false ? T.ruleEnable : T.ruleDisable),
                h('button', { style: CSS.danger, onClick: () => act('rm:' + r.id, () => postRule({ action: 'remove', id: r.id })) }, T.ruleDelete),
              ),
              r.note ? h('div', { style: { ...CSS.muted, fontSize: 11, marginTop: 4 } }, r.note) : null,
            ),
          ),
          ruleForm(kind),
        );
      };

      return h('div', { style: CSS.gearPanel },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '⚙ ' + T.gearTitle),
        h('div', { style: CSS.gearLead }, T.gearLead),
        h('div', { style: CSS.tabRow },
          h('button', { style: tab === 'tags' ? CSS.activeBtn : CSS.btn, onClick: () => setTab('tags') }, `${T.tabTags}（${cust.tags.length}）`),
          h('button', { style: tab === 'rules' ? CSS.activeBtn : CSS.btn, onClick: () => setTab('rules') }, `${T.tabRules}（${cust.rules.length}）`),
          h('button', { style: tab === 'auto' ? CSS.activeBtn : CSS.btn, onClick: () => setTab('auto') }, `${T.tabAuto}（${cust.auto.length}）`),
        ),
        err ? h('div', { style: { fontSize: 12, marginBottom: 8, color: 'rgb(220,120,120)' } }, '⚠ ' + err) : null,
        tab === 'tags' ? tagsTab : tab === 'rules' ? ruleList('rules') : ruleList('auto'),
      );
    }

    // ── 时间段 + 标签 两级分组 ──────────────────────────────────────────
    // 时段只有三个：上午 / 下午 / 晚上（按需求，只加这三个）。
    // 边界：< 12:00 上午；12:00–17:59 下午；>= 18:00 晚上。
    const pad2 = (n) => String(n).padStart(2, '0');

    function periodOf(d) {
      const hh = d.getHours();
      if (hh < 12) return { key: 'am', label: T.periodMorning, order: 0 };
      if (hh < 18) return { key: 'pm', label: T.periodAfternoon, order: 1 };
      return { key: 'ev', label: T.periodEvening, order: 2 };
    }

    function dayKeyOf(d) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    // 一天的时段：固定 上午→下午→晚上（当天的自然顺序，不随时间倒序）
    const PERIODS = [
      { key: 'am', label: T.periodMorning, order: 0 },
      { key: 'pm', label: T.periodAfternoon, order: 1 },
      { key: 'ev', label: T.periodEvening, order: 2 },
    ];

    /**
     * 把会话列表分组为四级：年份 → 日期 → 时段 → 标签。
     * 返回 [{ year, yearTotal, days: [{ dayKey, dateLabel, stamp, total,
     *          periods: [{ key, label, total, labels: [{ name, color, items }] }] }] }]
     *
     * 排序：整列「从远到近、从下到上」⇒ 越靠上越新。
     *   - 年份：倒序（新的年在上面）。
     *   - 日期：倒序（新的天在上面）。
     *   - 时段：上午 → 下午 → 晚上（当天自然顺序）。
     *   - 组内对话：从远到近（旧的在上、新的在下）。
     */
    function groupByTimeAndLabel(items, allTags) {
      const byYear = new Map();
      for (const it of items) {
        const raw = it.createdAt || it.decidedAt || it.generatedAt;
        const d = raw ? new Date(raw) : null;
        const ok = d && !Number.isNaN(d.getTime());
        const year = ok ? d.getFullYear() : 0;
        const dayKey = ok ? dayKeyOf(d) : 'unknown';
        const per = ok ? periodOf(d) : { key: 'am', label: T.periodMorning, order: 0 };
        if (!byYear.has(year)) byYear.set(year, { year, stamp: ok ? new Date(year, 0, 1).getTime() : 0, days: new Map() });
        const y = byYear.get(year);
        if (!y.days.has(dayKey)) y.days.set(dayKey, { dayKey, stamp: ok ? d.getTime() : 0, periods: new Map() });
        const day = y.days.get(dayKey);
        if (!day.periods.has(per.key)) day.periods.set(per.key, { key: per.key, label: per.label, order: per.order, items: [] });
        day.periods.get(per.key).items.push({ it, t: ok ? d.getTime() : 0 });
      }

      const out = [];
      for (const y of [...byYear.values()].sort((a, b) => b.year - a.year)) { // 新的年在上
        const days = [];
        for (const day of [...y.days.values()].sort((a, b) => b.stamp - a.stamp)) { // 新的天在上
          const sample = new Date(day.stamp || 0);
          const dateLabel = day.dayKey === 'unknown'
            ? '时间未知'
            : `${sample.getMonth() + 1} 月 ${sample.getDate()} 日`;
          const periods = [];
          for (const p of PERIODS) {
            const got = day.periods.get(p.key);
            if (!got) continue;
            const list = got.items.slice().sort((a, b) => a.t - b.t).map((x) => x.it); // 组内：远 → 近
            periods.push({ key: p.key, label: p.label, order: p.order, total: list.length, labels: groupByLabel(list, allTags) });
          }
          days.push({ dayKey: day.dayKey, dateLabel, stamp: day.stamp, total: periods.reduce((n, p) => n + p.total, 0), periods });
        }
        out.push({
          year: y.year,
          yearLabel: y.year === 0 ? '时间未知' : `${y.year} 年`,
          yearTotal: days.reduce((n, d) => n + d.total, 0),
          days,
        });
      }
      return out;
    }

    /** 时段内按标签再分：每个标签一组，没标签的归到「未分类」放最后。 */
    function groupByLabel(list, allTags) {
      const known = (allTags || []).map((t) => t.name);
      const colorOf = (n) => ((allTags || []).find((t) => t.name === n) || {}).color || '#6b7280';
      const map = new Map();
      for (const it of list) {
        const ls = (it.labels || []).filter(Boolean);
        if (ls.length) {
          // 一个会话有多个标签就进多组（每个标签下一份），便于按标签找
          for (const n of ls) {
            if (!map.has(n)) map.set(n, []);
            map.get(n).push(it);
          }
        } else {
          if (!map.has(null)) map.set(null, []);
          map.get(null).push(it);
        }
      }
      // 排序：有标签的按标签名（先按 knownTag 顺序，其次字母）；「未分类」永远最后。
      const named = [...map.keys()].filter((k) => k !== null);
      named.sort((a, b) => {
        const ia = known.indexOf(a); const ib = known.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        return String(a).localeCompare(String(b), 'zh');
      });
      const out = named.map((n) => ({ name: n, color: colorOf(n), items: map.get(n) }));
      if (map.has(null)) out.push({ name: null, color: null, items: map.get(null) });
      return out;
    }

    // ── 主视图 ──────────────────────────────────────────────────────────
    function ArchiveKeeperView() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });
      const [filter, setFilter] = React.useState('all');
      const [pendingSlim, setPendingSlim] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [expanded, setExpanded] = React.useState({}); // 默认全折叠
      const [trashConfirm, setTrashConfirm] = React.useState(false);
      const [gearOpen, setGearOpen] = React.useState(false);
      const [keptOpen, setKeptOpen] = React.useState(false); // 「已保留」的子项是否展开
      const [gearTab, setGearTab] = React.useState('tags');
      const [labelPick, setLabelPick] = React.useState(null); // 正在给哪个会话挑标签

      const load = React.useCallback(async () => {
        try {
          const data = await fetchList();
          setState({ phase: 'ready', data, error: null });
          return data;
        } catch (err) {
          setState({ phase: 'error', data: null, error: String(err?.message || err) });
          return null;
        }
      }, []);

      // 轮询：空闲时 15s 一次（省资源）；**提炼进行中时 1.5s 一次**，
      // 这样点完「重新提炼」能很快看到 running 变 false、数字刷新，
      // 不会出现「点了没反应、以为卡住」的观感。
      const runningNow = !!(state.data && state.data.running);
      React.useEffect(() => {
        load();
        const period = runningNow ? 1500 : 15000;
        const t = setInterval(load, period);
        return () => clearInterval(t);
      }, [load, runningNow]);

      const data = state.data;
      const all = (data && data.items) || [];
      const trash = (data && data.trash) || { count: 0, bytes: 0, items: [] };

      const items = all.filter((it) => {
        // 「已删除」独立成组，其它分组都不含它。
        if (filter === 'deleted') return it.decision === 'deleted';
        if (it.decision === 'deleted') return filter === 'all';
        if (filter === 'todo') return !it.decidedAt;
        // 「已保留」是个分组，下面只含两类；待决定的不会进这两类。
        if (filter === 'kept') return !!it.decidedAt;
        if (filter === 'original') return !!it.decidedAt && it.decision === 'keepBoth';
        if (filter === 'slim') return !!it.decidedAt && it.decision === 'keepSummary';
        // 「值得留存」是**独立**分组（和「已删除」一样单独隔开）：
        // 只看价值判断，不看是否已处理 —— 待决定的、已保留的都在这里。
        // wantKeep 由宿主按「自定义规则 > 默认判断」算好，和 decision 无关。
        if (filter === 'reusable') return it.wantKeep === true || it.reusable === true;
        return true;
      });

      // ── 时间段 + 标签 两级分组 ──
      // 时间：先按天分（远 → 近），天内再分上午/下午/晚上。
      // 排序：越新的越靠上（组与组之间倒序），组内对话按时间从远到近（越旧越靠上）。
      const groups = groupByTimeAndLabel(items);

      const toggle = (id) => setExpanded((s) => ({ ...s, [id]: !s[id] }));
      const allExpanded = items.length > 0 && items.every((it) => expanded[it.id]);
      const toggleAll = () =>
        setExpanded((s) => {
          const next = { ...s };
          for (const it of items) next[it.id] = !allExpanded;
          return next;
        });

      // 操作完成后自动折叠这张卡：把 id 记进 collapsedRef，
      // 等 list 刷新回来（卡片状态变了）再统一收起，避免刷新期间又弹开。
      const collapsedRef = React.useRef(null);
      React.useEffect(() => {
        const id = collapsedRef.current;
        if (!id) return;
        collapsedRef.current = null;
        setExpanded((s) => (s[id] ? { ...s, [id]: false } : s));
      });

      const run = async (fn, id, okMsg) => {
        setBusy(id);
        setNotice(null);
        try {
          await fn();
          if (okMsg) setNotice(okMsg);
          // 只有针对具体会话的操作才自动折叠；回收站 / 重新提炼等不折叠。
          if (id && id !== '__trash__' && id !== '__run__') collapsedRef.current = id;
          await load();
        } catch (err) {
          setNotice(`${T.errDecide}: ${err?.message || err}`);
        } finally {
          setBusy(null);
          setPendingSlim(null);
        }
      };

      // 「重新提炼」：必须读服务端返回的 started，如实反馈。
      // 以前不管三七二十一都提示「已启动…」，重复点时会一直显示启动中却毫无变化 —— 看起来就是卡死。
      const doRerun = async () => {
        if (runningNow || busy === '__run__') return; // 提炼中：按钮已禁用，这里再兜一层
        setBusy('__run__');
        setNotice(null);
        try {
          const r = await postRun();
          if (r && r.started === false) {
            setNotice(T.rerunAlready); // 服务端说已经在跑了
          } else {
            setNotice(T.rerunStarted);
          }
          await load();
        } catch (err) {
          setNotice(`${T.rerunFailed}: ${err?.message || err}`);
        } finally {
          setBusy(null);
        }
      };

      const decide = (id, decision) => run(() => postDecide(id, decision), id, decision === 'keepSummary' ? null : null);
      const restore = (id) => run(() => postRestore(id), id, T.restored);
      const hardDelete = (id) => {
        if (!window.confirm(T.confirmHardDelete)) return;
        return run(() => postHardDelete(id), id, T.stDeleted + ' —— 原文与摘要已移入回收站，可从「已删除」恢复');
      };
      const restoreDeleted = (id) => run(() => postRestoreDeleted(id), id, T.restored);

      // 给某个会话手工打 / 取消标签（不折叠卡片，方便连续点几个标签）
      const tagAct = async (id, name, on) => {
        try {
          const r = await postTag({ action: 'label', id, name, on });
          if (r && r.ok === false) setNotice('⚠ ' + (r.error || '打标签失败'));
          await load();
        } catch (e) {
          setNotice('⚠ ' + String(e?.message || e));
        }
      };
      const emptyTrash = () => run(() => postEmptyTrash(null), '__trash__', T.trashed).then(() => setTrashConfirm(false));

      // ── 头部计数：全部走「实时」口径 ────────────────────────────────────
      // 归档总数 / 已提炼 / 待提炼 都来自当前实际存在的归档会话，
      // 取消归档、彻底删除、新增归档后立刻同步；不再显示只增不减的历史累计。
      const cnt = {
        archived: data ? data.archivedTotal : 0,
        processed: data ? data.processedTotal : 0,
        pending: data ? (data.pendingTotal != null ? data.pendingTotal : Math.max(0, (data.archivedTotal || 0) - (data.processedTotal || 0))) : 0,
        // 无法提炼：原文已被删除或提炼失败。既不算已提炼也不算待提炼，
        // 界面上单独标出来，免得「归档 19 / 已提炼 16 / 待提炼 0」看起来对不上账。
        unprocessable: data ? (data.unprocessableTotal || 0) : 0,
      };

      const header = h(
        'div',
        { style: CSS.bar },
        h('span', { style: { fontWeight: 600 } }, T.view),
        data
          ? h('span', { style: { ...CSS.muted, fontSize: 12 } },
              `${T.archivedTotal} ${cnt.archived} · ${T.processed} ${cnt.processed}` +
              (cnt.pending > 0 ? ` · ${T.pending} ${cnt.pending}` : '') +
              (cnt.unprocessable > 0 ? ` · 无法提炼 ${cnt.unprocessable}` : ''),
              runningNow ? h('span', { style: { marginLeft: 6 } }, '· 提炼中…') : null,
            )
          : null,
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { style: CSS.btn, onClick: toggleAll, title: allExpanded ? T.collapseAll : T.expandAll }, allExpanded ? '⊟' : '⊞'),
        h('button', { style: CSS.btn, onClick: load, title: T.refresh }, '⟳'),
        h('button', {
          style: gearOpen ? CSS.gearBtnOn : CSS.gearBtn,
          onClick: () => setGearOpen((v) => !v),
          title: T.gear,
        }, '⚙' + (data?.customization?.hasCustom ? '•' : '')),
        // 提炼进行中：按钮禁用并显示「提炼中…」，从根上杜绝重复点击导致的假死
        h('button', {
          style: runningNow || busy === '__run__' ? { ...CSS.btn, opacity: 0.5, cursor: 'default' } : CSS.btn,
          disabled: runningNow || busy === '__run__',
          onClick: doRerun,
          title: runningNow ? T.rerunAlready : T.rerun,
        }, runningNow || busy === '__run__' ? T.rerunning : T.rerun),
      );

      const filters = h(
        'div',
        { style: { ...CSS.bar, position: 'relative', paddingTop: 0, borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,0.18))' } },
        h('button', { style: filter === 'all' ? CSS.activeBtn : CSS.btn, onClick: () => setFilter('all') }, T.filterAll),
        h('button', { style: filter === 'todo' ? CSS.activeBtn : CSS.btn, onClick: () => setFilter('todo') }, T.filterTodo),
        // 「已保留」分组：点它看全部已保留。
        // 子项（原文在 / 已精简）渲染在**另一个平面**（position:absolute 浮层），
        // 不占筛选栏的布局宽度，所以展开时其它按钮一个都不会位移。
        h('span', { style: CSS.sep },
          h('button', {
            style: filter === 'kept' || filter === 'original' || filter === 'slim' ? CSS.activeBtn : CSS.btn,
            onClick: () => {
              if (filter === 'kept' && keptOpen) { setKeptOpen(false); return; } // 再点一次收起
              setFilter('kept');
              setKeptOpen(true);
            },
          }, T.filterKept),
          // 选定子项后：收起浮层，把选中的那一项**作为一个正常按钮显示在同一层**，
          // 和「全部 / 待决定 / 已保留 …」并排，布局自然（不浮、不撑破）。
          !keptOpen && (filter === 'original' || filter === 'slim')
            ? h('button', {
                style: CSS.activeBtn,
                onClick: () => setKeptOpen(true), // 点它可重新展开换一个
                title: T.filterKept,
              }, '→ ' + (filter === 'original' ? T.filterOriginal : T.filterSlim))
            : null,
          keptOpen
            ? h('div', { style: CSS.subPlane },
                h('div', { style: CSS.subPlaneTitle }, T.filterKept),
                h('button', {
                  style: filter === 'original' ? CSS.activeBtn : CSS.btn,
                  onClick: () => { setFilter('original'); setKeptOpen(false); },
                }, T.filterOriginal),
                h('button', {
                  style: filter === 'slim' ? CSS.activeBtn : CSS.btn,
                  onClick: () => { setFilter('slim'); setKeptOpen(false); },
                }, T.filterSlim),
              )
            : null,
        ),
        // 「值得留存」单独隔开：和「已删除」一样是独立分组，不看已保留/待决定的状态。
        // 无论是否处理过，只要值得留存就收进来。
        h('span', { style: CSS.sep },
          h('button', { style: filter === 'reusable' ? CSS.activeBtn : CSS.btn, onClick: () => setFilter('reusable') }, T.filterReusable),
        ),
        h('span', { style: CSS.sep },
          h('button', { style: filter === 'deleted' ? CSS.activeBtn : CSS.btn, onClick: () => setFilter('deleted') }, T.filterDeleted),
        ),
      );

      const trashBar = trash.count
        ? h(
            'div',
            { style: CSS.trashBox },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, T.trash),
              h('span', { style: { ...CSS.muted, fontSize: 12 } }, `${trash.count} ${T.trashCount} · ${fmtSize(trash.bytes)}`),
              h('span', { style: { flex: '1 1 auto' } }),
              h('button', { style: CSS.danger, onClick: () => setTrashConfirm((v) => !v) }, T.emptyTrash),
            ),
            trashConfirm
              ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: { fontSize: 12, marginBottom: 6 } }, T.trashWarn),
                  h('ul', { style: CSS.ul },
                    ...trash.items.slice(0, 20).map((t, i) =>
                      h('li', { key: i, style: CSS.li }, `${t.id} — ${fmtSize(t.bytes)}`),
                    ),
                  ),
                  h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                    h('button', { style: CSS.danger, disabled: busy === '__trash__', onClick: emptyTrash }, busy === '__trash__' ? T.emptying : T.trashConfirm),
                    h('button', { style: CSS.btn, onClick: () => setTrashConfirm(false) }, T.trashCancel),
                  ),
                )
              : null,
          )
        : null;

      const body = (() => {
        if (state.phase === 'loading') return h('div', { style: { padding: 24, ...CSS.muted } }, T.loading);
        if (state.phase === 'error') return h('div', { style: { padding: 24 } }, `${T.errLoad}: ${state.error}`);
        return h('div', { style: CSS.list },
          gearOpen ? h(CustomizePanel, { data, load, tab: gearTab, setTab: setGearTab }) : null,
          trashBar,
          notice ? h('div', { style: { ...CSS.muted, marginBottom: 10, fontSize: 12 } }, notice) : null,
          !items.length ? h('div', { style: { padding: 18, ...CSS.muted } }, filter === 'deleted' ? T.deletedEmpty : T.empty) : null,
          ...renderGroups(groups),
        );
      })();

      // 年份 → 日期 → 时段 → 标签 → 卡片
      function renderGroups(groups) {
        const out = [];
        let firstYear = true;
        for (const y of groups) {
          out.push(h('div', { key: 'y:' + y.year, style: firstYear ? CSS.yearHeadFirst : CSS.yearHead },
            h('span', { style: CSS.yearText }, y.yearLabel),
            h('span', { style: CSS.timeCount }, `${y.yearTotal} 个对话`),
          ));
          firstYear = false;
          let firstDay = true;
          for (const d of y.days) {
            out.push(h('div', { key: 'd:' + y.year + ':' + d.dayKey, style: firstDay ? CSS.timeHeadFirst : CSS.timeHead },
              h('span', { style: CSS.timeDate }, d.dateLabel),
              h('span', { style: CSS.timeCount }, `${d.total} 个`),
            ));
            firstDay = false;
            for (const p of d.periods) {
              out.push(h('div', { key: 'p:' + y.year + ':' + d.dayKey + ':' + p.key, style: CSS.periodRow },
                h('span', { style: CSS.timePeriod }, p.label),
                h('span', { style: CSS.timeCount }, `${p.total} 个`),
              ));
              for (const g of p.labels) {
                out.push(h('div', { key: 'l:' + y.year + ':' + d.dayKey + ':' + p.key + ':' + (g.name || '_'), style: { marginLeft: 2 } },
                  h('div', { style: { ...CSS.labelHead, marginTop: 8 } },
                    h('span', { style: { ...CSS.labelBar, background: g.color || 'var(--dsh-border, rgba(128,128,128,0.5))' } }),
                    h('span', null, g.name || T.untagged),
                    h('span', { style: CSS.labelCount }, `${g.items.length} 个`),
                  ),
                  ...g.items.map((it) =>
                    card(it, {
                      decide, restore, hardDelete, restoreDeleted, busy, expanded: !!expanded[it.id], toggle,
                      pendingSlim: pendingSlim === it.id, setPendingSlim,
                      allTags: ((data && data.customization) || {}).tags || [],
                      labelPick: labelPick === it.id,
                      setLabelPick,
                      tagAct,
                    }),
                  ),
                ));
              }
            }
          }
        }
        return out;
      }

      return h('div', { style: CSS.wrap }, header, filters, body);
    }

    function section(title, arr) {
      if (!arr || !arr.length) return null;
      return h('div', null,
        h('div', { style: CSS.secTitle }, title),
        h('ul', { style: CSS.ul }, ...arr.slice(0, 12).map((t, i) => h('li', { key: i, style: CSS.li }, String(t)))),
      );
    }

    /**
     * 单张卡片：默认折叠，只显示标题 + 状态标签。
     * 展开后才显示摘要、要点、以及**按当前状态决定**的操作按钮。
     */
    function card(it, ctl) {
      const { decide, restore, hardDelete, restoreDeleted, busy, expanded, toggle, pendingSlim, setPendingSlim } = ctl;
      const allTags = ctl.allTags || [];
      const labelPick = !!ctl.labelPick;
      const setLabelPick = ctl.setLabelPick || (() => {});
      const tagAct = ctl.tagAct || (() => {});
      const myLabels = it.labels || [];
      const tagColor = (name) => (allTags.find((t) => t.name === name) || {}).color || '#6b7280';
      const isBusy = busy === it.id;
      const undecided = !it.decidedAt;

      // 状态标签
      const tags = [h('span', { key: 'c', style: CSS.tag }, CATEGORY_LABEL[it.category] || it.category)];
      if (it.decision === 'deleted') tags.push(h('span', { key: 'x', style: CSS.tagWarn }, T.stDeleted));
      else if (undecided) tags.push(h('span', { key: 'u', style: CSS.tagWarn }, T.filterTodo));
      else if (it.decision === 'keepBoth') tags.push(h('span', { key: 'o', style: CSS.tagOk }, T.stOriginal));
      else if (it.lost) tags.push(h('span', { key: 'l', style: CSS.tagWarn }, T.stLost));
      else tags.push(h('span', { key: 's', style: CSS.tag }, T.stSlim));
      // 自定义标签（打在标题后面，一眼能看到）
      for (const n of myLabels) {
        tags.push(h('span', { key: 'tag:' + n, style: { ...CSS.chip, cursor: 'default', fontSize: 10, padding: '1px 6px' }, title: '自定义标签' },
          h('span', { style: { ...CSS.dot, background: tagColor(n), width: 6, height: 6 } }), n));
      }
      if (it.decision !== 'deleted') {
        if (it.customKeep) tags.push(h('span', { key: 'ck', style: CSS.tagOk }, T.keepByCustom));
        else if (it.reusable === true) tags.push(h('span', { key: 'r', style: CSS.tag }, T.reusable));
      }

      const headRow = h('div', { style: CSS.cardHead, onClick: () => toggle(it.id), role: 'button', 'aria-expanded': expanded ? 'true' : 'false' },
        h('span', { style: CSS.caret }, expanded ? '▾' : '▸'),
        h('span', { style: CSS.cardTitle }, it.title || it.id),
        ...tags,
      );

      if (!expanded) return h('div', { key: it.id, style: CSS.card }, headRow);

      // ── 展开区 ──
      const actions = [];

      if (it.decision === 'deleted') {
        // ── 已删除：只提供「恢复」，恢复到被删前的状态 ──
        const backTo = it.prevDecision === 'keepSummary' ? T.stSlim : T.stOriginal;
        actions.push(
          h('span', { key: 'st', style: { ...CSS.muted, fontSize: 12 } },
            `${T.stDeleted}${it.deletedAt ? ` · ${fmtDate(it.deletedAt)}` : ''} · ${T.prevWas}：${backTo}`),
          it.canRestoreDeleted
            ? h('button', { key: 'rd', style: CSS.primaryBtn, disabled: isBusy, onClick: () => restoreDeleted(it.id) },
                isBusy ? T.restoring : `${T.restoreDeleted}（→ ${backTo}）`)
            : h('span', { key: 'nb', style: { ...CSS.muted, fontSize: 12 } }, '回收站已清空，无法恢复'),
        );
      } else if (undecided) {
        // 三个选项：保留原文 / 只留摘要 / 彻底删除
        actions.push(
          h('div', { key: 'opts', style: { flex: '1 1 100%' } },
            h('div', { style: CSS.optBox },
              h('div', { style: CSS.optTitle }, T.keepBoth),
              h('div', { style: CSS.hint }, T.keepBothHint),
              h('button', { style: CSS.primaryBtn, disabled: isBusy, onClick: () => decide(it.id, 'keepBoth') }, T.keepBoth),
            ),
            h('div', { style: CSS.optBox },
              h('div', { style: CSS.optTitle }, T.keepSummary),
              h('div', { style: CSS.hint }, T.keepSummaryHint),
              pendingSlim
                ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: { ...CSS.muted, fontSize: 12 } }, T.confirmSlim),
                    h('button', { style: CSS.danger, disabled: isBusy, onClick: () => decide(it.id, 'keepSummary') }, T.confirm),
                    h('button', { style: CSS.btn, onClick: () => setPendingSlim(null) }, T.cancel),
                  )
                : h('button', { style: CSS.btn, disabled: isBusy, onClick: () => setPendingSlim(it.id) }, T.keepSummary),
            ),
            h('div', { style: CSS.optBox },
              h('div', { style: CSS.optTitle }, T.hardDelete),
              h('div', { style: CSS.hint }, T.hardDeleteHint),
              h('button', { style: CSS.danger, disabled: isBusy, onClick: () => hardDelete(it.id) }, T.hardDelete),
            ),
          ),
        );
      } else if (it.decision === 'keepBoth') {
        // 已保留·原文在 → 可转为「只留摘要」，或「彻底删除」
        actions.push(
          h('span', { key: 'st', style: { ...CSS.muted, fontSize: 12 } }, `${T.decidedHint}：${T.keepBoth}`),
          pendingSlim
            ? h('span', { key: 'cf', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { ...CSS.muted, fontSize: 12 } }, T.confirmSlim),
                h('button', { style: CSS.danger, disabled: isBusy, onClick: () => decide(it.id, 'keepSummary') }, T.confirm),
                h('button', { style: CSS.btn, onClick: () => setPendingSlim(null) }, T.cancel),
              )
            : h('button', { key: 'slim', style: CSS.btn, disabled: isBusy, onClick: () => setPendingSlim(it.id) }, T.keepSummary),
          h('button', { key: 'hd', style: CSS.danger, disabled: isBusy, onClick: () => hardDelete(it.id) },
            isBusy ? T.hardDeleting : T.hardDelete),
        );
      } else {
        // 已保留·已精简 → 能恢复就显示恢复，并可「彻底删除」
        actions.push(
          h('span', { key: 'st', style: { ...CSS.muted, fontSize: 12 } }, `${T.decidedHint}：${T.keepSummary}`),
          it.canRestore
            ? h('button', { key: 'rs', style: CSS.primaryBtn, disabled: isBusy, onClick: () => restore(it.id) }, isBusy ? T.restoring : T.restore)
            : h('span', { key: 'nb', style: { ...CSS.muted, fontSize: 12 } }, it.lost ? '回收站里已无副本' : '回收站里没有可恢复的副本'),
          h('button', { key: 'hd', style: CSS.danger, disabled: isBusy, onClick: () => hardDelete(it.id) },
            isBusy ? T.hardDeleting : T.hardDelete),
        );
      }

      return h('div', { key: it.id, style: CSS.card },
        headRow,
        h('div', { style: CSS.cardBody },
          it.summary ? h('div', { style: CSS.summary }, it.summary) : null,
          h('div', { style: { ...CSS.muted, fontSize: 11 } },
            `${fmtDate(it.createdAt)} · ${it.userTurnCount} ${T.userTurns}` +
            (it.trashedAt ? ` · ${T.stSlim} ${fmtDate(it.trashedAt)}` : '') +
            (it.fileExists ? ` · ${fmtSize(it.fileSize)}` : ''),
          ),
          // ── 自定义标签：给这个对话手工打标签 ──
          it.decision === 'deleted' ? null : h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...CSS.secTitle, display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', null, T.tabTags),
              h('button', {
                style: CSS.btn,
                onClick: () => setLabelPick(labelPick ? null : it.id),
              }, labelPick ? T.cancel : (myLabels.length ? '修改标签' : '＋ 标签')),
            ),
            labelPick
              ? (!allTags.length
                  ? h('div', { style: { ...CSS.muted, fontSize: 12, marginTop: 6 } },
                      '还没有标签可用 —— 点右上角 ⚙ 到「标签」页建几个。')
                  : h('div', { style: { ...CSS.chipWrap, marginTop: 6 } },
                      ...allTags.map((t) => {
                        const on = myLabels.includes(t.name);
                        return h('span', {
                          key: t.name,
                          style: { ...(on ? CSS.chipOn : CSS.chip), opacity: isBusy ? 0.5 : 1 },
                          onClick: () => tagAct(it.id, t.name, !on),
                        }, h('span', { style: { ...CSS.dot, background: t.color } }), t.name, on ? ' ✓' : '');
                      }),
                    ))
              : null,
          ),
          section(T.keyPoints, it.keyPoints),
          section(T.decisions, it.decisions),
          section(T.facts, it.facts),
          section(T.deliverables, it.deliverables),
          section(T.openThreads, it.openThreads),
          section(T.obsolete, it.obsolete),
          h('div', { style: CSS.actions }, ...actions),
        ),
      );
    }

    /**
     * 对话头部工具条上的入口按钮 + 面板。
     *
     * 座位是 `conversation.session.header.utilities`（list-kind, scope: session），
     * 即每个对话头部右侧那排工具按钮 —— 满足「每个对话都有」。
     */
    function ArchiveKeeperButton() {
      const [open, setOpen] = React.useState(false);
      const boxRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
          if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      return h('div', { ref: boxRef, style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button', title: T.view, 'aria-label': T.view,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((v) => !v),
          style: CSS.trigger,
        }, h('span', null, T.view)),
        open ? h('div', { style: CSS.popover }, h(ArchiveKeeperView, null)) : null,
      );
    }

    // ── 注册进对话头部工具条 ───────────────────────────────────────────
    // `inject` 必须导出：cordis 靠它声明本插件依赖的服务，等服务就绪才调 apply。
    // 少了它，apply 会在 `slots` 还没挂上时被调用，注册失败 → fiber 进入 failed，
    // 前端 boot 检查就会报 “web boot: 1 entry did not activate / dsh-archive-keeper: failed”。
    // 第一方客户端插件（ui-trajectory / ui-sidebar-files / ui-plan …）全都导出 apply + inject。
    const inject = ['slots'];

    function apply(ctx) {
      // 只在宿主真的声明了这条座位时才注册（headless/tui 没有 ⇒ 不激活）。
      return ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: VIEW_ID, order: 50 },
          ArchiveKeeperButton,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
