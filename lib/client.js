/**
 * dsh-maintainer-doc-guard — browser half.
 *
 * Adds one right-sidebar tab ("维护者文档") that lists the configured maintainer
 * documents, shows each one in a text area, and writes edits back to disk
 * through the host routes registered by ./index.js.
 *
 * Hand-written and build-free on purpose: it requires only the platform seed
 * modules (`react`), so it cannot trip the "require missed the module table"
 * failure that rc.*-era bundles hit on 0.1.5.
 */
var module = { exports: {} }
var exports = module.exports

window.__ModuleLoader__.load({
  id: 'dsh-maintainer-doc-guard',
  factory: function (require) {
    'use strict'

    var React = require('react')
    var h = React.createElement

    /** The tab kind this package owns. */
    var KIND = 'maintainer-docs'
    /** This implementation's identity, and the key its body registers under. */
    var TAB_ID = 'dsh-maintainer-doc-guard'
    /** Host data plane. */
    var ROUTE = '/dsh-maintainer-doc-guard/docs'
    /** Host settings plane (the Settings-page card). */
    var SETTINGS_ROUTE = '/dsh-maintainer-doc-guard/settings'
    /** Host on-topic mode plane (the sidebar strict-mode switch). */
    var MODE_ROUTE = '/dsh-maintainer-doc-guard/mode'
/** The advisory-notice switch group (same process-level plane as MODE_ROUTE). */
var NOTICES_ROUTE = '/dsh-maintainer-doc-guard/notices'
    /** Host orphan-sweep plane (list + remove document folders of dead sessions). */
    var ORPHANS_ROUTE = '/dsh-maintainer-doc-guard/orphans'
    /** Host "reveal in file manager" plane. */
    var REVEAL_ROUTE = '/dsh-maintainer-doc-guard/reveal'
    /** The settings namespace the host half registers; the card is dispatched BY it. */
    var SETTINGS_NS = 'maintainer-doc-guard'

    /**
     * The runtime knobs, grouped by which gate they belong to. Copy lives here
     * (not in a locale table) because this bundle is hand-written and
     * build-free; a language switch re-registers nothing, the strings are
     * simply rendered as-is.
     */
    var PRECEDENT_FIELD_COPY = [
      {
        key: 'gateEnabled',
        kind: 'boolean',
        label: '启用写前契约门禁',
        hint: '关掉后不再拦截"凭记忆造基础设施文件"，只剩每轮"先读维护者文档"的提醒',
      },
      {
        key: 'gateDryRun',
        kind: 'boolean',
        label: '只观察，不拦截（dryRun）',
        hint: '命中条件时只累加"dryRun 命中"，不真的拒绝',
      },
      {
        key: 'gateMaxDeniesPerTarget',
        kind: 'number',
        min: 0,
        max: 20,
        label: '同一目标最大拒绝次数',
        hint: '用尽后放行并计入"超预算放行"，避免顽固模型把自己的轮次锁死',
      },
    ]

    var INTENT_FIELD_COPY = [
      {
        key: 'intentEnabled',
        kind: 'boolean',
        label: '启用动手前意图门禁',
        hint: '本轮若直接调 write/edit/bash 而没先说明这一步要干什么，拦下并要一行说明',
      },
      {
        key: 'intentDryRun',
        kind: 'boolean',
        label: '只观察，不拦截（dryRun）',
        hint: '命中条件时只累加"dryRun 命中"，不真的拒绝',
      },
      {
        key: 'intentMaxBlocksPerTurn',
        kind: 'number',
        min: 0,
        max: 10,
        label: '每轮最大拦截次数',
        hint: '默认 1：说明一次就放行整轮。设 0 等于只观察，设大则反复要求说明',
      },
      {
        key: 'intentMinChars',
        kind: 'number',
        min: 0,
        max: 400,
        label: '算作"说明了"的最少字数',
        hint: '本轮 assistant 文本累计超过这个长度即视为已说明。调大更严格，调小更宽松',
      },
    ]

    /** The objective anchor: the standing reminder of what the user actually asked for. */
    var ANCHOR_FIELD_COPY = [
      {
        key: 'anchorEnabled',
        kind: 'boolean',
        label: '常驻"当前目标"锚',
        hint: '把用户最近一条消息原文钉进系统提示（末尾），并写明优先级：用户最新指令 > 你自己上轮说的计划 > 你自己发现的线索。关掉则不再注入',
      },
    ]

    /** The staged correction: remind first, deny only if the reminder is ignored. */
    var NUDGE_FIELD_COPY = [
      {
        key: 'nudgeGrace',
        kind: 'number',
        min: 0,
        max: 10,
        label: '先提醒后拦截的免拦次数',
        hint: '默认 1：本轮第一次没说明就动手时，只注入一条提醒、动作照常执行；再犯才拒。设 0 恢复"第一次就拒"',
      },
      {
        key: 'nudgeAfterSteps',
        kind: 'number',
        min: 0,
        max: 200,
        label: '自转复核阈值（步）',
        hint: '本轮步数超过它就注入一次"目标复核"提醒，每轮最多一次。设 0 关闭',
      },
    ]

    /** The whole card, in render order. */
    var GATE_FIELD_COPY = PRECEDENT_FIELD_COPY
      .concat(INTENT_FIELD_COPY)
      .concat(ANCHOR_FIELD_COPY)
      .concat(NUDGE_FIELD_COPY)

    /** Stable selector identity (a fresh closure each render would defeat the store's cheap compare). */
    function identity(sessions) {
      return sessions
    }

    /** The type's glyph: a sheet of paper with a folded corner. */
    function Glyph(props) {
      var size = (props && props.size) || 16
      return h('svg', {
        width: String(size),
        height: String(size),
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      }, h('path', {
        d: 'M3.5 1.75h5.75L12.75 5.5v8.75a.75.75 0 0 1-.75.75h-8.5a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75Z',
        stroke: 'currentColor',
        strokeWidth: '1.1',
        strokeLinejoin: 'round',
      }), h('path', {
        d: 'M9.25 1.85V5.5h3.4',
        stroke: 'currentColor',
        strokeWidth: '1.1',
        strokeLinejoin: 'round',
      }))
    }

    /** The tab type's registry definition. */
    function definition() {
      return {
        id: TAB_ID,
        kind: KIND,
        priority: 'builtin',
        title: function () { return '维护者文档' },
        guide: [{
          order: 60,
          title: function () { return '维护者文档' },
          description: function () { return '查看并编辑 plan / conventions / stack / state' },
          icon: Glyph,
        }],
      }
    }

    var styles = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        fontSize: '13px',
        color: 'var(--color-text-primary, inherit)',
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '10px 12px 6px',
      },
      title: { fontWeight: 500, fontSize: '13px' },
      cwd: {
        fontSize: '11px',
        color: 'var(--color-text-tertiary, #888)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      tabs: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        padding: '0 10px 8px',
        borderBottom: '1px solid var(--color-border-tertiary, rgba(0,0,0,.12))',
      },
      tab: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1.5',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '0.5px solid var(--color-border-tertiary, rgba(0,0,0,.15))',
        background: 'transparent',
        color: 'var(--color-text-secondary, #666)',
        cursor: 'pointer',
      },
      tabActive: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1.5',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '0.5px solid var(--color-border-info, #185fa5)',
        background: 'var(--color-background-info, #e6f1fb)',
        color: 'var(--color-text-info, #185fa5)',
        cursor: 'pointer',
      },
      textarea: {
        flex: '1 1 auto',
        minHeight: '180px',
        width: '100%',
        boxSizing: 'border-box',
        resize: 'vertical',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '12px',
        lineHeight: '1.6',
        padding: '10px 12px',
        border: 'none',
        outline: 'none',
        background: 'var(--color-background-primary, transparent)',
        color: 'var(--color-text-primary, inherit)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderTop: '1px solid var(--color-border-tertiary, rgba(0,0,0,.12))',
      },
      btn: {
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--color-border-secondary, rgba(0,0,0,.25))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        background: 'var(--color-background-info, #185fa5)',
        color: '#ffffff',
        borderColor: 'transparent',
      },
      off: { opacity: 0.45, cursor: 'default' },
      status: {
        fontSize: '11px',
        color: 'var(--color-text-tertiary, #888)',
        marginLeft: 'auto',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      error: { color: 'var(--color-text-danger, #e24b4a)', fontSize: '12px' },
      note: {
        padding: '12px',
        fontSize: '12px',
        color: 'var(--color-text-tertiary, #888)',
      },
      // ---- Settings-page card (设置 → 插件 → 插件配置) ----
      card: {
        listStyle: 'none',
        border: '0.5px solid var(--color-border-tertiary, rgba(0,0,0,.15))',
        borderRadius: '10px',
        background: 'var(--color-background-secondary, transparent)',
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '12px 14px',
      },
      cardName: { fontWeight: 600, fontSize: '14px' },
      cardDesc: {
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--color-text-tertiary, #888)',
      },
      rows: { display: 'flex', flexDirection: 'column' },
      group: { display: 'flex', flexDirection: 'column' },
      groupHead: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '10px 14px 8px',
        borderTop: '1px solid var(--color-border-tertiary, rgba(0,0,0,.10))',
        background: 'var(--color-background-secondary, rgba(0,0,0,.02))',
      },
      groupTitle: { fontSize: '12px', fontWeight: '600', color: 'var(--color-text-primary, inherit)' },
      groupNote: { fontSize: '11px', color: 'var(--color-text-tertiary, #888)', lineHeight: '1.5' },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '10px 14px',
        borderTop: '1px solid var(--color-border-tertiary, rgba(0,0,0,.10))',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
      rowLabel: { fontSize: '13px' },
      rowHint: { fontSize: '12px', color: 'var(--color-text-tertiary, #888)', lineHeight: '1.5' },
      rowControl: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' },
      number: {
        width: '64px',
        font: 'inherit',
        fontSize: '13px',
        padding: '3px 6px',
        borderRadius: '6px',
        border: '0.5px solid var(--color-border-secondary, rgba(0,0,0,.25))',
        background: 'var(--color-background-primary, transparent)',
        color: 'var(--color-text-primary, inherit)',
      },
      chip: {
        fontSize: '11px',
        lineHeight: '1.6',
        padding: '0 6px',
        borderRadius: '999px',
        border: '0.5px solid var(--color-border-info, #185fa5)',
        color: 'var(--color-text-info, #185fa5)',
      },
      link: {
        font: 'inherit',
        fontSize: '12px',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--color-text-info, #185fa5)',
        cursor: 'pointer',
      },
      notice: {
        padding: '10px 14px',
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--color-text-warning, #9a6b00)',
        background: 'var(--color-background-warning, rgba(255,200,0,.10))',
      },
      cardFoot: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '4px 10px',
        padding: '10px 14px',
        borderTop: '1px solid var(--color-border-tertiary, rgba(0,0,0,.10))',
      },
      stats: {
        fontSize: '11px',
        color: 'var(--color-text-tertiary, #888)',
        minWidth: 0,
        whiteSpace: 'nowrap',
      },
    }

    /**
     * The tab body. List the maintainer documents, show one at a time, write
     * edits back through the host route. The working directory comes straight
     * from the session store, so the panel follows whichever session is open;
     * when the framework hook is not present the host falls back to the cwd it
     * recorded at the last prompt assembly.
     */
    function DocsBody(props) {
      var p = props || {}
      var sessionId = p.sessionId
      var useSessions = p.useSessions

      var allSessions = typeof useSessions === 'function' ? useSessions(identity) : null
      var cwd = allSessions && allSessions.byId && sessionId
        ? (allSessions.byId[sessionId] || {}).cwd
        : undefined

      var docsPair = React.useState(null)
      var docs = docsPair[0]
      var setDocs = docsPair[1]
      var activePair = React.useState(0)
      var active = activePair[0]
      var setActive = activePair[1]
      var draftPair = React.useState('')
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var statusPair = React.useState('')
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var errPair = React.useState(null)
      var err = errPair[0]
      var setErr = errPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      // The answer-contract switch. `null` until the host answers, so the
      // control renders as "unknown" rather than lying about the current mode.
      var strictPair = React.useState(null)
      var strict = strictPair[0]
      var setStrict = strictPair[1]

      function loadMode() {
        fetch(MODE_ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.text() : '' })
          .then(function (t) {
            if (!t) return
            try {
              var d = JSON.parse(t)
              setStrict(d && d.ok === true ? d.strictOnTopic === true : null)
            } catch (e) { /* leave null */ }
          })
          .catch(function () { /* leave null */ })
      }

      function toggleStrict(next) {
        setStrict(next)
        fetch(MODE_ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ strictOnTopic: next }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.text()
          })
          .then(function (t) {
            try {
              var d = JSON.parse(t)
              if (d && d.ok === true) setStrict(d.strictOnTopic === true)
            } catch (e) { /* keep optimistic value */ }
          })
          .catch(function (error) {
            setErr('切换扣题模式失败：' + String((error && error.message) || error))
            loadMode()
          })
      }

      // The advisory-notice switch group. `null` until the host answers, so each
      // control renders "?" instead of claiming a state the plugin may not be in.
      var noticesPair = React.useState(null)
      var notices = noticesPair[0]
      var setNotices = noticesPair[1]

      var NOTICE_LABELS = [
        ['ledger', '经验本命中', '命中经验本里的同工具同位置问题时，把那条教训贴出来一次'],
        ['content', '落点核对', '一次编辑让数字净减少时，要求先判定那些数字/结论在别处是否另有落点'],
        ['verify', '验证读数', '写过代码类文件后，下一次调用提醒一次“跑哪条命令、期望什么、实际是什么”'],
        ['induce', '自动归纳', '一次失败后同一目标调用成功时，自动把这条教训追加进经验本'],
      ]

      function loadNotices() {
        fetch(NOTICES_ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.text() : '' })
          .then(function (t) {
            if (!t) return
            try {
              var d = JSON.parse(t)
              if (d && d.ok === true && d.switches) setNotices(d.switches)
            } catch (e) { /* leave null */ }
          })
          .catch(function () { /* leave null */ })
      }

      function toggleNotice(key, next) {
        var patch = {}
        patch[key] = next
        setNotices(Object.assign({}, notices || {}, patch))
        fetch(NOTICES_ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ switches: patch }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.text()
          })
          .then(function (t) {
            try {
              var d = JSON.parse(t)
              if (d && d.ok === true && d.switches) setNotices(d.switches)
            } catch (e) { /* keep optimistic value */ }
          })
          .catch(function (error) {
            setErr('切换提醒开关失败：' + String((error && error.message) || error))
            loadNotices()
          })
      }

      function revealFolder() {
        setErr(null)
        setStatus('正在打开文件夹…')
        fetch(REVEAL_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: cwd, session: sessionId }),
        })
          .then(function (response) { return response.text() })
          .then(function (t) {
            var d = null
            try { d = JSON.parse(t) } catch (e) { d = null }
            if (!d || d.ok !== true) {
              setStatus('')
              setErr('打开文件夹失败：' + ((d && d.error) || '未知原因'))
              return
            }
            setStatus('已打开 · ' + (d.path || ''))
          })
          .catch(function (error) {
            setStatus('')
            setErr('打开文件夹失败：' + String((error && error.message) || error))
          })
      }

      function sweepOrphans() {
        setErr(null)
        setStatus('正在检查孤儿文档…')
        fetch(ORPHANS_ROUTE + '?cwd=' + encodeURIComponent(cwd || ''), { headers: { accept: 'application/json' } })
          .then(function (response) { return response.text() })
          .then(function (t) {
            var d = null
            try { d = JSON.parse(t) } catch (e) { d = null }
            if (!d || d.ok !== true) {
              setStatus('')
              setErr('检查失败：' + ((d && d.error) || '未知原因'))
              return
            }
            if (d.sweepable !== true) {
              setStatus('')
              setErr('无法清理：' + (d.reason || '会话注册表不可用'))
              return
            }
            if (!d.candidates || d.candidates.length === 0) {
              setStatus('没有孤儿文档（共 ' + (d.total || 0) + ' 个会话文件夹）')
              return
            }
            var msg = '将删除 ' + d.candidates.length + ' 个已不存在会话的文档文件夹：\n' + d.candidates.join('\n') + '\n\n确定继续？'
            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(msg)) {
              setStatus('已取消')
              return
            }
            return fetch(ORPHANS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ cwd: cwd }),
            })
              .then(function (r2) { return r2.text() })
              .then(function (t2) {
                var d2 = null
                try { d2 = JSON.parse(t2) } catch (e) { d2 = null }
                if (!d2 || d2.ok !== true) {
                  setStatus('')
                  setErr('清理失败：' + ((d2 && d2.error) || '未知原因'))
                  return
                }
                setStatus('已清理 ' + ((d2.removed && d2.removed.length) || 0) + ' 个孤儿文件夹')
              })
          })
          .catch(function (error) {
            setStatus('')
            setErr('清理失败：' + String((error && error.message) || error))
          })
      }

      function load() {
        setErr(null)
        setStatus('读取中…')
        var params = []
        if (cwd) params.push('cwd=' + encodeURIComponent(cwd))
        if (sessionId) params.push('session=' + encodeURIComponent(sessionId))
        var url = ROUTE + (params.length ? '?' + params.join('&') : '')
        fetch(url, { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) {
              return response.text().then(function (t) { throw new Error('HTTP ' + response.status + (t ? ': ' + t : '')) })
            }
            return response.text().then(function (t) {
              if (!t || t.length === 0) throw new Error('服务器返回了空响应体（可能 dsh 仍在跑旧实例 / 多实例端口冲突）')
              return JSON.parse(t)
            })
          })
          .then(function (data) {
            if (!data || data.ok !== true) {
              setErr((data && data.error) || '读取失败')
              setStatus('')
              return
            }
            var list = data.docs || []
            setDocs(list)
            var index = Math.min(active, list.length - 1)
            if (index < 0) index = 0
            setActive(index)
            setDraft((list[index] || {}).content || '')
            setStatus('已加载')
          })
          .catch(function (error) {
            setErr(String((error && error.message) || error))
            setStatus('')
          })
      }

      React.useEffect(function () {
        load()
        loadMode()
        loadNotices()
      }, [cwd])

      function selectTab(index) {
        setActive(index)
        setDraft(docs && docs[index] ? (docs[index].content || '') : '')
        setErr(null)
        setStatus('')
      }

      function save() {
        if (!docs || !docs[active]) return
        setBusy(true)
        setErr(null)
        setStatus('保存中…')
        fetch(ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: cwd, session: sessionId, name: docs[active].name, content: draft }),
        })
          .then(function (response) {
            if (!response.ok) {
              return response.text().then(function (t) { throw new Error('HTTP ' + response.status + (t ? ': ' + t : '')) })
            }
            return response.text().then(function (t) {
              if (!t || t.length === 0) throw new Error('服务器返回了空响应体')
              return JSON.parse(t)
            })
          })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setErr((data && data.error) || '保存失败')
              setStatus('')
              return
            }
            var next = docs.slice()
            next[active] = Object.assign({}, next[active], { content: draft, exists: true })
            setDocs(next)
            setStatus('已保存 · ' + (data.bytes || 0) + ' 字节')
          })
          .catch(function (error) {
            setBusy(false)
            setErr(String((error && error.message) || error))
            setStatus('')
          })
      }

      if (err !== null && docs === null) {
        return h('div', { style: styles.panel },
          h('div', { style: styles.note }, h('span', { style: styles.error }, err)),
          h('div', { style: { padding: '0 12px 12px' } },
            h('button', { style: styles.btn, type: 'button', onClick: load }, '重试')))
      }

      var current = docs && docs[active] ? docs[active] : null
      var dirty = current ? draft !== (current.content || '') : false

      return h('div', { style: styles.panel },
        h('div', { style: styles.head },
          h('span', { style: styles.title }, '维护者文档'),
          h('span', { style: styles.cwd, title: cwd || '' }, cwd || '(未知工作区)')),
        h('div', { style: styles.tabs },
          (docs || []).map(function (doc, index) {
            return h('button', {
              key: doc.name,
              type: 'button',
              title: doc.exists ? doc.name : doc.name + '（尚未创建）',
              style: index === active ? styles.tabActive : styles.tab,
              onClick: function () { selectTab(index) },
            }, doc.exists ? doc.name : doc.name + ' ·未建')
          })),
        current
          ? h('textarea', {
            style: styles.textarea,
            value: draft,
            spellCheck: false,
            placeholder: '（空文件，可直接在此编辑后点“保存”）',
            onChange: function (event) {
              setDraft(event.target.value)
              setStatus('未保存')
              setErr(null)
            },
          })
          : h('div', { style: styles.note }, docs === null ? '读取中…' : '（没有配置任何文档）'),
        h('div', { style: styles.bar },
          h('button', {
            style: Object.assign({}, styles.btn, busy ? styles.off : {}),
            type: 'button',
            disabled: busy,
            onClick: load,
          }, '重载'),
          h('button', {
            style: Object.assign({}, styles.btn, styles.primary, (busy || !dirty) ? styles.off : {}),
            type: 'button',
            disabled: busy || !dirty,
            onClick: save,
          }, dirty ? '保存' : '已保存'),
          h('button', {
            style: Object.assign({}, styles.btn, strict === true ? styles.primary : {}),
            type: 'button',
            title: strict === true
              ? '严格扣题：回答必须先回扣提问，离题即停。点击切回宽松模式。'
              : '宽松模式：延伸由你自发，标注只是补个说明，不必每次都写。点击切到严格扣题。',
            onClick: function () { toggleStrict(strict !== true) },
          }, strict === true ? '严格扣题 · 开' : (strict === false ? '严格扣题 · 关' : '严格扣题 · ?')),
          h('span', { style: { marginLeft: '6px', opacity: 0.75, fontSize: '11px' } }, '提醒：'),
          NOTICE_LABELS.map(function (item) {
            var key = item[0]
            var on = notices === null ? null : notices[key] === true
            return h('button', {
              key: key,
              style: Object.assign({}, styles.btn, on === true ? styles.primary : {}),
              type: 'button',
              title: item[2] + '（点击开关；进程级，重启回到默认全开）',
              onClick: function () { toggleNotice(key, on !== true) },
            }, item[1] + ' · ' + (on === null ? '?' : (on ? '开' : '关')))
          }),
          h('button', {
            style: styles.btn,
            type: 'button',
            title: '在系统文件管理器中打开本会话的维护者文档文件夹',
            onClick: revealFolder,
          }, '打开文件夹'),
          h('button', {
            style: styles.btn,
            type: 'button',
            title: '删除已不存在会话遗留的文档文件夹（会先列出清单并确认）',
            onClick: sweepOrphans,
          }, '清理孤儿文档'),
          h('span', { style: styles.status, title: err || status }, err ? err : status)))
    }

    /**
     * The Settings page card. Registered into `settings.plugin.item` under the
     * namespace key the host half registers, so 设置 → 插件 → 插件配置 dispatches
     * it once the namespace is served. Its data plane is this plugin's OWN route
     * — deliberately NOT `ctx.settingsScope`, so the card cannot break the
     * sidebar tab by waiting on a client service that a deployment may not mount.
     */
    function GuardSettingsCard() {
      var payloadPair = React.useState(null)
      var payload = payloadPair[0]
      var setPayload = payloadPair[1]
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var statusPair = React.useState('')
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var errPair = React.useState(null)
      var err = errPair[0]
      var setErr = errPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      function accept(data) {
        setPayload(data)
        var next = {}
        var value = data && data.value ? data.value : {}
        GATE_FIELD_COPY.forEach(function (field) {
          var raw = value[field.key]
          next[field.key] = field.kind === 'number' ? String(raw === undefined ? '' : raw) : raw === true
        })
        setDraft(next)
      }

      function load() {
        setErr(null)
        setStatus('读取中…')
        fetch(SETTINGS_ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) {
              return response.text().then(function (t) { throw new Error('HTTP ' + response.status + (t ? ': ' + t : '')) })
            }
            return response.text().then(function (t) {
              if (!t || t.length === 0) throw new Error('服务器返回了空响应体')
              return JSON.parse(t)
            })
          })
          .then(function (data) {
            if (!data || data.ok !== true) {
              setErr((data && data.error) || '读取失败')
              setStatus('')
              return
            }
            accept(data)
            setStatus('已加载')
          })
          .catch(function (error) {
            setErr(String((error && error.message) || error))
            setStatus('')
          })
      }

      React.useEffect(function () { load() }, [])

      function send(body, note) {
        setBusy(true)
        setErr(null)
        setStatus(note)
        fetch(SETTINGS_ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (response) { return response.json() })
          .then(function (data) {
            setBusy(false)
            if (!data || data.ok !== true) {
              setErr((data && data.error) || '写入失败')
              setStatus('')
              return
            }
            accept(data)
            setStatus('已保存')
          })
          .catch(function (error) {
            setBusy(false)
            setErr(String((error && error.message) || error))
            setStatus('')
          })
      }

      function patchOf() {
        if (draft === null || payload === null) return null
        var value = payload.value || {}
        var patch = {}
        GATE_FIELD_COPY.forEach(function (field) {
          var raw = draft[field.key]
          if (field.kind === 'boolean') {
            if (raw !== Boolean(value[field.key])) patch[field.key] = raw === true
            return
          }
          var parsed = Number(raw)
          if (raw === '' || !isFinite(parsed)) return
          if (parsed !== Number(value[field.key])) patch[field.key] = parsed
        })
        return patch
      }

      var patch = patchOf()
      var dirty = patch !== null && Object.keys(patch).length > 0
      var served = payload !== null && payload.served === true
      var stats = payload && payload.gate ? payload.gate : {}

      function row(field) {
        var overridden = payload && payload.overridden ? payload.overridden[field.key] === true : false
        var control
        if (field.kind === 'boolean') {
          control = h('input', {
            type: 'checkbox',
            checked: draft ? draft[field.key] === true : false,
            disabled: busy || !served,
            style: { margin: 0, cursor: served ? 'pointer' : 'default' },
            onChange: function (event) {
              setDraft(Object.assign({}, draft, { [field.key]: event.target.checked }))
              setStatus('未保存')
              setErr(null)
            },
          })
        } else {
          control = h('input', {
            type: 'number',
            min: field.min === undefined ? undefined : String(field.min),
            max: field.max === undefined ? undefined : String(field.max),
            value: draft ? draft[field.key] : '',
            disabled: busy || !served,
            style: styles.number,
            onChange: function (event) {
              setDraft(Object.assign({}, draft, { [field.key]: event.target.value }))
              setStatus('未保存')
              setErr(null)
            },
          })
        }
        return h('div', { key: field.key, style: styles.row },
          h('div', { style: styles.rowText },
            h('span', { style: styles.rowLabel }, field.label),
            h('span', { style: styles.rowHint }, field.hint)),
          h('div', { style: styles.rowControl },
            overridden ? h('span', { style: styles.chip }, '已覆盖') : null,
            overridden ? h('button', {
              type: 'button',
              style: Object.assign({}, styles.link, busy ? styles.off : {}),
              disabled: busy,
              onClick: function () { send({ unset: [field.key] }, '恢复默认…') },
            }, '恢复默认') : null,
            control))
      }

      var groupHead = function (title, note) {
        return h('div', { style: styles.groupHead },
          h('span', { style: styles.groupTitle }, title),
          h('span', { style: styles.groupNote }, note))
      }

      return h('li', { style: styles.card },
        h('div', { style: styles.cardHead },
          h('div', { style: styles.rowText },
            h('span', { style: styles.cardName }, '维护者文档守卫'),
            h('span', { style: styles.cardDesc },
              '两道门禁：① 写受护目录（.dsh/profiles、.dsh/skills、.dsh/.agent-presets、node_modules/@deepseek-ai）'
              + '前必须先读过同名先例；② 动手前先说明这一步要干什么，没说就拦一次。')),
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.btn, busy ? styles.off : {}),
            disabled: busy,
            onClick: load,
          }, '重载')),
        served
          ? null
          : h('div', { style: styles.notice },
            '本部署未挂载设置服务（settings），此处只读。请改 profile 的 cordis.patch.yml 里的 gate.* / intent.* / anchor.* / nudge.*。'),
        h('div', { style: styles.rows },
          payload === null
            ? h('div', { style: styles.note }, '读取中…')
            : h('div', { style: styles.group },
              groupHead('① 写前契约门禁', '凭记忆造基础设施文件时拦下'),
              PRECEDENT_FIELD_COPY.map(row),
              groupHead('② 动手前意图门禁', '没说明这一步的目的就直接动手时拦下'),
              INTENT_FIELD_COPY.map(row))),
        h('div', { style: styles.cardFoot },
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.btn, styles.primary, (busy || !dirty) ? styles.off : {}),
            disabled: busy || !dirty,
            onClick: function () { if (patch !== null) send({ patch: patch }, '保存中…') },
          }, dirty ? '保存' : '已保存'),
          h('span', { style: styles.stats },
            '写前：监听 ' + (stats.seen || 0) + ' · 拒绝 ' + (stats.denied || 0)
            + ' · 超预算 ' + (stats.gaveUp || 0) + ' · dryRun ' + (stats.wouldDeny || 0)
            + ' · 已读 ' + (stats.reads || 0)),
          h('span', { style: styles.stats },
            '意图：拦截 ' + (stats.intentBlocked || 0)
            + ' · dryRun ' + (stats.intentWouldBlock || 0)
            + ' · 超预算 ' + (stats.intentGaveUp || 0)
            + (stats.intentDisarmed ? ' · ⚠未观测到通道(已自停 ' + stats.intentDisarmed + ')' : '')),
          h('span', { style: styles.status, title: err || status }, err ? err : status)))
    }

    var api = {
      name: 'maintainer-doc-guard-client',
      inject: ['slots', 'sidebarRightTabs'],
      apply: function (ctx) {
        ctx.effect(function () {
          try {
            return ctx.sidebarRightTabs.register(definition())
          } catch (error) {
            try { console.warn('[maintainer-doc-guard] tab type registration failed:', error) } catch (ignored) { /* noop */ }
            return function () {}
          }
        }, 'maintainer-doc-guard: tab type')

        ctx.effect(function () {
          try {
            return ctx.slots.inject('sidebar.right.pane.tab', function () {
              return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, DocsBody)
            })
          } catch (error) {
            try { console.warn('[maintainer-doc-guard] tab body registration failed:', error) } catch (ignored) { /* noop */ }
            return function () {}
          }
        }, 'maintainer-doc-guard: tab body')

        // The Settings-page card. `ctx.slots.inject` is a SOFT declaration: when
        // the Plugins settings section is not part of this deployment the
        // callback simply never runs, so the card costs nothing and — crucially
        // — cannot take the sidebar tab down with it.
        ctx.effect(function () {
          try {
            return ctx.slots.inject('settings.plugin.item', function () {
              return ctx.slots.register({ name: 'settings.plugin.item', key: SETTINGS_NS }, GuardSettingsCard)
            })
          } catch (error) {
            try { console.warn('[maintainer-doc-guard] settings card registration failed:', error) } catch (ignored) { /* noop */ }
            return function () {}
          }
        }, 'maintainer-doc-guard: settings card')
      },
    }

    module.exports = api
    return module.exports
  },
})
