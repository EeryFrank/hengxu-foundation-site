/* ============ 主题切换 + 多语言引擎（表页面） ============
 * 主题：hx_theme = 'light'|'dark'（localStorage），默认白色（light），用户切换后记忆选择。
 * 语言：hx_lang = BCP-47 code（localStorage），默认 zh。
 *   字典：assets/i18n.js 的 I18N（langs 语言清单 / en 全文英译 / chrome 主要语言框架）。
 *   切换语言 = 存 hx_lang 后刷新页面；加载时若 lang≠zh 则全文替换。
 *   内容回退规则：zh 中文原文；其余语言 = 英文全文 + 该语言框架（若有 chrome 字典）。
 * 本文件不用于 bbs.html（里页面保持终端中文界面）。
 */
(function(){
  'use strict';

  /* ---------- 主题 ---------- */
  var THEME_KEY = 'hx_theme';
  function storedTheme(){ try{ return localStorage.getItem(THEME_KEY); }catch(e){ return null; } }
  function applyTheme(t, save){
    document.documentElement.setAttribute('data-theme', t);
    if(save){ try{ localStorage.setItem(THEME_KEY, t); }catch(e){} }
    var b = document.getElementById('themeBtn');
    if(b) b.textContent = (t === 'dark') ? '◑' : '◐';
  }
  applyTheme(storedTheme() || 'light', false);

  /* ---------- 语言 ---------- */
  var LANG_KEY = 'hx_lang';
  var RTL = { ar:1, ur:1, fa:1, he:1 };
  var hasI18N = (typeof I18N !== 'undefined');
  var lang = 'zh';
  try{ lang = localStorage.getItem(LANG_KEY) || 'zh'; }catch(e){}

  function norm(s){ return String(s).replace(/\s+/g, ' ').trim(); }

  /* 当前语言的有效字典：英文全文为底，框架语言覆盖 */
  function currentDict(){
    if(lang === 'zh' || !hasI18N) return null;
    var d = {};
    var k;
    for(k in I18N.en) d[norm(k)] = I18N.en[k];
    var c = I18N.chrome && I18N.chrome[lang];
    if(c){ for(k in c) d[norm(k)] = c[k]; }
    return d;
  }

  /* 富文本特例：含内联标签、无法按文本节点映射的块 */
  var SPECIAL = {
    '.hero h1': {
      zh: '让<em>帮助</em>，<br>按次序抵达。',
      other: 'Let <em>help</em>,<br>arrive in good order.'
    },
    '.hero-meta .stat:first-child b small': { zh: '座', other: '' }
  };

  function translateTextNodes(root, dict){
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node, batch = [];
    while((node = walker.nextNode())){
      if(node.parentNode && /^(SCRIPT|STYLE)$/.test(node.parentNode.nodeName)) continue;
      var key = norm(node.nodeValue);
      if(key && dict[key] !== undefined) batch.push([node, dict[key]]);
    }
    batch.forEach(function(p){ p[0].nodeValue = p[1]; });
  }

  function translateAttrs(dict){
    ['placeholder', 'title', 'value'].forEach(function(attr){
      document.querySelectorAll('[' + attr + ']').forEach(function(el){
        var key = norm(el.getAttribute(attr));
        if(key && dict[key] !== undefined) el.setAttribute(attr, dict[key]);
      });
    });
  }

  function translateTitle(dict){
    document.title = document.title.split('·').map(function(part){
      var k = norm(part);
      return dict[k] || part.trim();
    }).join(' · ');
  }

  function applySpecial(){
    for(var sel in SPECIAL){
      var el = document.querySelector(sel);
      if(!el) continue;
      el.innerHTML = (lang === 'zh') ? SPECIAL[sel].zh : SPECIAL[sel].other;
    }
  }

  function applyLang(){
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL[lang] ? 'rtl' : 'ltr';
    applySpecial();
    var dict = currentDict();
    if(!dict) return;
    translateTextNodes(document.body, dict);
    translateAttrs(dict);
    translateTitle(dict);
    /* 动态内容（捐赠查询结果等）出现后补译 */
    var obs = new MutationObserver(function(muts){
      muts.forEach(function(m){
        m.addedNodes.forEach(function(n){
          if(n.nodeType === 1) translateTextNodes(n, dict);
          if(n.nodeType === 3){ var k = norm(n.nodeValue); if(dict[k] !== undefined) n.nodeValue = dict[k]; }
        });
      });
    });
    obs.observe(document.body, { childList:true, subtree:true });
  }

  /* ---------- 注入头部按钮与语言选择面板 ---------- */
  function injectUI(){
    var headIn = document.querySelector('.head-in');
    if(!headIn) return;

    /* 汉堡菜单（移动端） */
    var nav = headIn.querySelector('.nav');
    if(nav){
      var menuBtn = document.createElement('button');
      menuBtn.className = 'menu-btn'; menuBtn.id = 'menuBtn';
      menuBtn.setAttribute('aria-label', '菜单');
      menuBtn.innerHTML = '<span></span><span></span><span></span>';
      menuBtn.addEventListener('click', function(){
        nav.classList.toggle('open');
        menuBtn.classList.toggle('x');
      });
      nav.querySelectorAll('a').forEach(function(a){
        a.addEventListener('click', function(){ nav.classList.remove('open'); menuBtn.classList.remove('x'); });
      });
      headIn.appendChild(menuBtn);
    }

    var themeBtn = document.createElement('button');
    themeBtn.className = 'theme-btn'; themeBtn.id = 'themeBtn';
    themeBtn.setAttribute('aria-label', '切换主题');
    themeBtn.addEventListener('click', function(){
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(cur, true);
    });
    headIn.appendChild(themeBtn);
    applyTheme(document.documentElement.getAttribute('data-theme'), false);

    if(!hasI18N) return;
    var langBtn = document.createElement('button');
    langBtn.className = 'lang-btn'; langBtn.id = 'langBtn';
    langBtn.textContent = nativeName(lang) + ' ▾';
    langBtn.addEventListener('click', function(){ panel.classList.add('on'); search.focus(); });
    headIn.appendChild(langBtn);

    var mask = document.createElement('div');
    mask.className = 'lang-mask';
    var panel = document.createElement('div'); panel.className = 'lang-panel';
    var search = document.createElement('input');
    search.className = 'lang-search';
    search.placeholder = (lang === 'zh') ? '搜索语言…' : 'Search languages…';
    var list = document.createElement('div'); list.className = 'lang-list';
    var note = document.createElement('div'); note.className = 'lang-note';
    note.textContent = (lang === 'zh')
      ? '本站正文目前提供中文与英文全文；其余语言由英文版承载，界面框架持续补译中。'
      : 'Full content available in 中文 and English; other languages are carried by the English edition.';
    panel.appendChild(search); panel.appendChild(list); panel.appendChild(note);
    mask.appendChild(panel); document.body.appendChild(mask);
    mask.addEventListener('click', function(e){ if(e.target === mask) mask.classList.remove('on'); });

    function nativeName(code){
      for(var i = 0; i < I18N.langs.length; i++) if(I18N.langs[i][0] === code) return I18N.langs[i][1];
      return code;
    }
    function renderList(filter){
      var f = norm(filter).toLowerCase();
      list.innerHTML = '';
      I18N.langs.forEach(function(pair){
        if(f && pair[1].toLowerCase().indexOf(f) < 0 && pair[0].indexOf(f) < 0) return;
        var it = document.createElement('div');
        it.className = 'lang-item' + (pair[0] === lang ? ' cur' : '');
        it.innerHTML = '<span>' + pair[1] + '</span><span class="lc">' + pair[0] + '</span>';
        it.addEventListener('click', function(){
          try{ localStorage.setItem(LANG_KEY, pair[0]); }catch(e){}
          location.reload();
        });
        list.appendChild(it);
      });
    }
    search.addEventListener('input', function(){ renderList(search.value); });
    renderList('');
  }

  document.addEventListener('DOMContentLoaded', function(){
    injectUI();
    applyLang();
  });
})();

/* ============================================================
 * OC 免责声明：本文件为原创角色（OC）创作项目的虚构网站组成部分。
 * 恒序基金会、万界稳定局及站内所有数据、人物、组织、事件均为虚构，
 * 不代表任何真实机构，亦不接受任何实际捐赠。仅供创作交流与非商业演示。
 * ============================================================ */
