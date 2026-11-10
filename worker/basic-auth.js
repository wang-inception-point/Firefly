const COOKIE_NAME = "ff_auth";
const SESSION_TTL = 7 * 24 * 60 * 60;
const ADMIN_NAME = "Anna";
const MAX_NAME_LEN = 20;
const MAX_FAIL = 5;
const FAIL_TTL = 600; // 失败锁定窗口 10 分钟
const GEO_TIMEOUT = 3500; // 地理库查询超时 3.5 秒
const DEFAULT_MAX_USERS = 10; // 注册人数上限默认值（KV 未配置时使用）
const MAX_USERS_KEY = "config:max_users"; // KV 中人数上限的配置键
const GH_REPO = "wang-inception-point/Firefly";
const GH_BRANCH = "master";
// 可在线编辑的四篇文章（路径相对仓库根）
const EDITABLE_POSTS = [
  { path: "src/content/posts/firefly.md", label: "沃雅妮莎 · 主题模板", cover: "src/content/posts/images/cover1.jpg" },
  { path: "src/content/posts/guide/index.md", label: "大黑塔 · 使用指南", cover: "src/content/posts/images/cover2.jpg" },
  { path: "src/content/posts/weekly-3.md", label: "清宵 · 11月周报", cover: "src/content/posts/images/cover3.jpg" },
  { path: "src/content/posts/code-examples.md", label: "刻律德菈 · 代码示例", cover: "src/content/posts/images/cover4.jpg" },
];

// 省级行政区代码 → 中文（Cloudflare 原生头降级用）
const PROVINCE_CODES = {
  11: "北京", 12: "天津", 13: "河北", 14: "山西", 15: "内蒙古",
  21: "辽宁", 22: "吉林", 23: "黑龙江", 31: "上海",
  32: "江苏", 33: "浙江", 34: "安徽", 35: "福建", 36: "江西",
  37: "山东", 41: "河南", 42: "湖北", 43: "湖南", 44: "广东",
  45: "广西", 46: "海南", 50: "重庆", 51: "四川", 52: "贵州",
  53: "云南", 54: "西藏", 61: "陕西", 62: "甘肃", 63: "青海",
  64: "宁夏", 65: "新疆", 71: "台湾", 81: "香港", 82: "澳门",
};

// 带超时的 fetch，任何异常返回 null（不阻断登录主流程）
async function fetchGeo(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEO_TIMEOUT);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, ...opts });
    return resp.ok ? resp : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 源1：ip9 —— IPv4/IPv6 都支持，HTTPS 中文，省+市
async function fromIp9(ip) {
  const resp = await fetchGeo(`https://ip9.com.cn/get?ip=${ip}`);
  if (!resp) return null;
  try {
    const d = (await resp.json()).data;
    if (!d) return null;
    return { province: d.prov || "", city: d.city || "", district: d.area || "" };
  } catch {
    return null;
  }
}

// 源2：pconline —— 仅 IPv4，GBK 中文，区县覆盖较好
async function fromPconline(ip) {
  if (ip.includes(":")) return null; // 其老后端不支持 IPv6
  const resp = await fetchGeo(
    `https://whois.pconline.com.cn/ipJson.jsp?ip=${ip}&json=true`,
    { headers: { Accept: "application/json" } },
  );
  if (!resp) return null;
  try {
    const text = new TextDecoder("gbk").decode(await resp.arrayBuffer());
    const d = JSON.parse(text);
    if (d.err) return null;
    return {
      province: d.pro || "",
      city: d.city || "",
      district: d.region || "",
    };
  } catch {
    return null;
  }
}

// 源3：ip-api —— HTTP 中文，IPv4/IPv6 兜底，省+市
async function fromIpApi(ip) {
  const resp = await fetchGeo(
    `http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,regionName,city`,
  );
  if (!resp) return null;
  try {
    const d = await resp.json();
    if (d.status !== "success") return null;
    return { province: d.regionName || "", city: d.city || "", district: "" };
  } catch {
    return null;
  }
}

// 登录地点：多源分层翻译，只返回中文地名，不返回、不存储 IP
// IPv4 优先 pconline 拿区县；IPv6 走 ip9/ip-api 拿省市
async function geoLocate(request, ip) {
  const cfFallback = () => ({
    province: PROVINCE_CODES[request.headers.get("CF-IPRegion")] || "",
    city: request.headers.get("CF-IPCity") || "",
    district: "",
  });

  // 仅允许合法 IP 字符进入 URL，防注入
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return cfFallback();

  const sources = ip.includes(":")
    ? [fromIp9, fromIpApi]
    : [fromPconline, fromIp9, fromIpApi];

  for (const src of sources) {
    const loc = await src(ip);
    if (loc && (loc.province || loc.city)) return loc;
  }
  return cfFallback();
}

function formatLocation(loc) {
  if (!loc) return "未知";
  const parts = [loc.province, loc.city, loc.district].filter(Boolean);
  return parts.length ? parts.join(" ") : "未知";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// 登录 / 注册页共用样式；背景图在各自页面的 body 内联指定
const AUTH_CSS = `
  :root{
    --glow:#7ee787;--green:#3fb950;--text:#e6f0e8;--muted:#9bb0a1;
    --border:rgba(126,231,135,.32);--card:rgba(11,19,15,.3);
  }
  *{box-sizing:border-box}
  html,body{min-height:100%;margin:0}
  body{
    font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
    color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;
    padding:24px 16px;position:relative;background-size:cover;background-position:center 10%;
  }
  body::before{
    content:"";position:absolute;inset:0;
    background:linear-gradient(160deg,rgba(8,16,12,.5),rgba(8,14,11,.32));
  }
  .card{
    position:relative;width:100%;max-width:400px;background:var(--card);
    border:1px solid var(--border);border-radius:18px;padding:32px 30px;
    box-shadow:0 18px 50px rgba(0,0,0,.5);
    -webkit-backdrop-filter:blur(8px) saturate(1.1);backdrop-filter:blur(8px) saturate(1.1);
    cursor:grab;touch-action:none;
  }
  .card.dragging{cursor:grabbing}
  .card input,.card button,.card a{cursor:auto}
  h1{
    font-family:"Noto Serif SC","Songti SC","STSong",serif;
    font-size:24px;margin:0 0 4px;font-weight:600;letter-spacing:2px;
    text-shadow:0 1px 3px rgba(0,0,0,.7);
  }
  h1 .dot{color:var(--glow)}
  .sub{color:var(--muted);font-size:13px;margin:0 0 24px}
  .field{margin-bottom:16px}
  .field label{display:block;font-size:13px;color:var(--muted);margin-bottom:7px;letter-spacing:1px}
  .field input{
    width:100%;padding:12px 14px;border-radius:10px;font-size:15px;color:var(--text);
    background:rgba(8,14,11,.18);border:1px solid rgba(126,231,135,.22);outline:none;
    -webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);
  }
  .field input:focus{border-color:var(--glow);box-shadow:0 0 0 3px rgba(126,231,135,.14)}
  .btn{
    width:100%;margin-top:8px;padding:13px;border:0;border-radius:11px;cursor:pointer;
    background:var(--green);color:#08130b;font-size:15px;font-weight:600;letter-spacing:2px;
  }
  .btn:hover{filter:brightness(1.08)}
  .btn:disabled{background:#3a4a40;color:#82948a;cursor:not-allowed;filter:none}
  .switch{text-align:center;margin:20px 0 0;font-size:13.5px;color:var(--muted)}
  .switch a{color:var(--glow);text-decoration:none}
  .switch a:hover{text-decoration:underline}
  .err{color:#ff8f7f;font-size:13px;margin:0 0 16px;padding:10px 12px;border-radius:9px;background:rgba(217,106,95,.14);border:1px solid rgba(217,106,95,.3)}
  .quota{margin-bottom:22px;padding:13px 15px;border-radius:11px;background:rgba(126,231,135,.08);border:1px solid rgba(126,231,135,.2)}
  .quota .qline{display:flex;justify-content:space-between;font-size:13px;margin-bottom:9px}
  .quota .qline b{color:var(--glow);font-variant-numeric:tabular-nums}
  .bar{height:7px;border-radius:999px;background:rgba(8,14,11,.8);overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--glow));border-radius:999px}
  .quota.full .bar i{background:linear-gradient(90deg,#d96a5f,#e88a7a)}
  .quota.full .qline b{color:#e89a8c}
  @media (max-width:480px){.card{padding:26px 22px}h1{font-size:21px}}
`;

// 卡片拖拽：鼠标与触摸统一用 Pointer Events；交互元素上不触发
const DRAG_JS = `
(function(){
  var card=document.querySelector('.card');
  if(!card)return;
  var sx=0,sy=0,ol=0,ot=0;
  function isInteractive(t){return !!t.closest('input,button,a,textarea,select,label');}
  card.addEventListener('pointerdown',function(e){
    if(isInteractive(e.target))return;
    var r=card.getBoundingClientRect();
    if(card.style.position!=='fixed'){
      card.style.position='fixed';
      card.style.left=r.left+'px';
      card.style.top=r.top+'px';
      card.style.margin='0';
    }
    sx=e.clientX;sy=e.clientY;
    ol=parseFloat(card.style.left);ot=parseFloat(card.style.top);
    try{card.setPointerCapture(e.pointerId);}catch(err){}
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove',function(e){
    if(!card.hasPointerCapture||!card.hasPointerCapture(e.pointerId))return;
    card.style.left=(ol+e.clientX-sx)+'px';
    card.style.top=(ot+e.clientY-sy)+'px';
  });
  function end(e){
    if(card.hasPointerCapture&&card.hasPointerCapture(e.pointerId)){
      try{card.releasePointerCapture(e.pointerId);}catch(err){}
      card.classList.remove('dragging');
    }
  }
  card.addEventListener('pointerup',end);
  card.addEventListener('pointercancel',end);
})();
`;

function loginHtml(error) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Firefly</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='8' fill='%237ee787'/%3E%3C/svg%3E">
<style>${AUTH_CSS}</style></head>
<body style="background-image:url('/auth-bg/auth-bg-1.jpg')">
<div class="card">
  <h1>欢迎回来<span class="dot"> · </span>萤火</h1>
  <p class="sub">登录后进入 Firefly 站点</p>
  <form method="POST" action="/__login">
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <div class="field">
      <label>账号（昵称）</label>
      <input type="text" name="name" placeholder="请输入注册的昵称" maxlength="20" autofocus required>
    </div>
    <div class="field">
      <label>密码</label>
      <input type="password" name="password" placeholder="请输入密码" required>
    </div>
    <button class="btn" type="submit">登 录</button>
  </form>
  <p class="switch">还没有账号？<a href="/__register">去注册</a></p>
</div>
<script>${DRAG_JS}</script>
</body></html>`;
}

// 注册页：current=当前已注册账号数，max=人数上限；满员时表单禁用
function registerHtml(error, current, max) {
  const full = current >= max;
  const pct = Math.min(100, Math.round((current / max) * 100));
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>注册 · Firefly</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='8' fill='%237ee787'/%3E%3C/svg%3E">
<style>${AUTH_CSS}</style></head>
<body style="background-image:url('/auth-bg/auth-bg-2.jpg')">
<div class="card">
  <h1>创建账号<span class="dot"> · </span>萤火</h1>
  <p class="sub">注册名额有限，先到先得</p>
  <div class="quota${full ? " full" : ""}">
    <div class="qline"><span>注册名额</span><b>${current} / ${max}</b></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
  </div>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  ${full ? `<p class="err">注册名额已满，无法继续注册。如需名额请联系管理员。</p>` : ""}
  <form method="POST" action="/__register">
    <div class="field">
      <label>账号（昵称，1–20 位）</label>
      <input type="text" name="name" placeholder="中英文 / 数字 / _-" maxlength="20" ${full ? "disabled" : ""} autofocus required>
    </div>
    <div class="field">
      <label>访问密码（共享）</label>
      <input type="password" name="password" placeholder="请输入站点访问密码" ${full ? "disabled" : ""} required>
    </div>
    <button class="btn" type="submit" ${full ? "disabled" : ""}>注 册</button>
  </form>
  <p class="switch">已有账号？<a href="/__login">去登录</a></p>
</div>
<script>${DRAG_JS}</script>
</body></html>`;
}

async function sign(env, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) {
      out[part.slice(0, i).trim()] = decodeURIComponent(
        part.slice(i + 1).trim(),
      );
    }
  }
  return out;
}

async function verifySession(env, header) {
  const raw = parseCookies(header)[COOKIE_NAME];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [exp, role, encName, sig] = parts;
  const expNum = parseInt(exp, 10);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return null;
  let name;
  try {
    name = decodeURIComponent(encName);
  } catch {
    return null;
  }
  if (role !== "admin" && role !== "user") return null;
  const expected = await sign(env, `${exp}.${role}.${name}`);
  if (sig.length !== expected.length) return null;
  const a = new TextEncoder().encode(sig);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return null;
  const ok = await crypto.subtle.timingSafeEqual(a, b);
  return ok ? { role, name, exp: expNum } : null;
}

function validName(name) {
  return (
    name.length >= 1 &&
    name.length <= MAX_NAME_LEN &&
    /^[一-龥A-Za-z0-9_\-.]+$/.test(name)
  );
}

// 读取注册人数上限：KV 配置优先，缺失或非法时回退默认值 10
async function getMaxUsers(env) {
  const v = parseInt((await env.FF_DATA.get(MAX_USERS_KEY)) || "", 10);
  return Number.isFinite(v) && v >= 1 ? v : DEFAULT_MAX_USERS;
}

// 管理员专属：注入静态页面的"回到管理面板"悬浮按钮（访客会话不注入，按钮本身只出现在管理员看到的页面）
function adminReentryHtml() {
  return `<div style="position:fixed;right:22px;bottom:22px;z-index:9999"><a href="/__panel-x7k2" style="display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:999px;background:#16241c;color:#7ee787;border:1px solid #2f4a39;font-size:14px;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.45)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7ee787" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 3 5-6"/></svg>管理面板</a></div>`;
}

// 时间戳（秒）→ 北京时间字符串；Worker 默认时区是 UTC，必须显式指定 Asia/Shanghai，否则会少 8 小时
function formatTime(ts) {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

function navHtml(active) {
  const items = [
    { href: "/__panel-x7k2", label: "访客记录", key: "visitors" },
    { href: "/__panel-x7k2/posts", label: "文章编辑", key: "posts" },
  ];
  return `<nav class="nav-tabs">${items.map((it) =>
    `<a href="${it.href}" class="${it.key === active ? "active" : ""}">${it.label}</a>`
  ).join("")}</nav>`;
}

function adminShell(title, sub, bodyHtml, active = "visitors") {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Firefly</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='8' fill='%237ee787'/%3E%3C/svg%3E">
<style>
  :root{
    --bg:#0c120e;--surface:#131c17;--surface-2:#182420;--border:#26362c;
    --glow:#7ee787;--green:#3fb950;--text:#e6f0e8;--muted:#9bb0a1;--faint:#6b7f73;
  }
  *{box-sizing:border-box}
  body{margin:0;color:var(--text);font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;min-height:100vh;padding:30px 20px 48px;background:var(--bg)}
  .wrap{max-width:980px;margin:0 auto}
  header h1{font-family:"Noto Serif SC","Songti SC",serif;font-size:28px;font-weight:600;margin:0;letter-spacing:2px}
  header .sub{color:var(--faint);font-size:13px;letter-spacing:1px;margin-top:6px}
  .nav-tabs{display:flex;gap:8px;margin:22px 0 6px;flex-wrap:wrap}
  .nav-tabs a{padding:9px 18px;border-radius:10px;font-size:14px;color:var(--muted);background:var(--surface);border:1px solid var(--border);text-decoration:none;letter-spacing:1px;transition:all .18s}
  .nav-tabs a:hover{color:var(--glow);border-color:rgba(126,231,135,.4)}
  .nav-tabs a.active{color:#08130b;background:var(--green);border-color:var(--green);font-weight:600}
  .post-list{display:grid;gap:12px;margin-top:18px}
  .post-item{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:18px 22px;border-radius:14px;background:var(--surface);border:1px solid var(--border);text-decoration:none;color:var(--text);transition:all .18s}
  .post-item:hover{border-color:var(--green);transform:translateY(-1px)}
  .post-item .lbl{font-size:16px;font-weight:600}
  .post-item .pth{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--faint);margin-top:5px}
  .post-item .go{color:var(--green);font-size:14px}
  textarea.md{width:100%;min-height:420px;padding:14px 16px;border-radius:12px;background:rgba(8,14,11,.85);border:1px solid var(--border);color:var(--text);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13.5px;line-height:1.6;outline:none;resize:vertical}
  textarea.md:focus{border-color:var(--glow);box-shadow:0 0 0 3px rgba(126,231,135,.14)}
  .btn-save{padding:11px 26px;border:0;border-radius:10px;cursor:pointer;background:var(--green);color:#08130b;font-size:14px;font-weight:600;letter-spacing:1px}
  .btn-save:hover{filter:brightness(1.08)}
  .form-actions{display:flex;gap:12px;align-items:center;margin-top:16px}
  .msg{padding:11px 16px;border-radius:10px;margin:14px 0;font-size:14px}
  .msg.ok{background:rgba(63,185,80,.15);color:var(--glow);border:1px solid rgba(63,185,80,.4)}
  .msg.err{background:rgba(232,110,100,.15);color:#ff9b8a;border:1px solid rgba(232,110,100,.4)}
  .hint{background:rgba(126,231,135,.06);border:1px solid rgba(126,231,135,.18);border-radius:10px;padding:12px 16px;margin-bottom:14px;color:var(--muted);font-size:13px;line-height:1.9}
  .hint b{color:var(--glow)}
  .hint code{background:rgba(0,0,0,.3);padding:2px 7px;border-radius:5px;color:var(--glow);font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
  .panel{border-radius:16px;background:var(--surface);border:1px solid var(--border);padding:22px;margin-top:18px}
  .back{color:var(--green);text-decoration:none;font-size:14px;padding:9px 18px;border:1px solid var(--border);border-radius:10px;display:inline-block}
  footer{margin-top:24px;color:var(--faint);font-size:12.5px}
</style></head>
<body><div class="wrap">
  <header><h1>${title}</h1><div class="sub">${sub}</div></header>
  ${navHtml(active)}
  ${bodyHtml}
  <footer>仅管理员可见 · 保存后 GitHub 自动触发 CF 重建（约 1 分钟生效）</footer>
</div></body></html>`;
}

async function ghGetRaw(env, path) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`, {
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "firefly-admin",
    },
  });
  if (!r.ok) throw new Error("GitHub GET " + r.status);
  const j = await r.json();
  const bytes = Uint8Array.from(atob(j.content.replace(/\s/g, "")));
  return { content: new TextDecoder("utf-8").decode(bytes), sha: j.sha };
}

async function ghPut(env, path, content, sha, message) {
  const body = {
    message,
    branch: GH_BRANCH,
    content: btoa(unescape(encodeURIComponent(content))),
  };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "firefly-admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("GitHub PUT " + r.status + " " + await r.text());
  return await r.json();
}

async function ghPutBinary(env, path, bytes, sha, message) {
  const body = {
    message,
    branch: GH_BRANCH,
    content: btoa(String.fromCharCode(...bytes)),
  };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "firefly-admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("GitHub IMG PUT " + r.status + " " + await r.text());
  return await r.json();
}

function postsListHtml(msg, err) {
  const items = EDITABLE_POSTS.map((p) => `
    <a class="post-item" href="/__panel-x7k2/posts/edit?path=${encodeURIComponent(p.path)}">
      <div><div class="lbl">${p.label}</div><div class="pth">${p.path}</div></div>
      <div class="go">编辑 →</div>
    </a>`).join("");
  return `${msg ? `<div class="msg ok">${msg}</div>` : ""}${err ? `<div class="msg err">${err}</div>` : ""}
  <div class="post-list">${items}</div>`;
}

function postsEditHtml(path, label, content, coverPath, err) {
  return `${err ? `<div class="msg err">${err}</div>` : ""}
  <div class="panel">
    <div style="margin-bottom:14px;color:var(--muted);font-size:14px">编辑：<b style="color:var(--glow)">${label}</b> <span style="color:var(--faint);font-family:monospace;font-size:12px">${path}</span></div>
    <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px">
      <div>
        <div style="color:var(--faint);font-size:12.5px;margin-bottom:8px">当前封面</div>
        <img src="/${coverPath.replace(/^src\/content\/posts\//, "").replace(/^images\//, "")}" style="width:240px;border-radius:10px;border:1px solid var(--border);display:block" onerror="this.style.opacity=.3">
      </div>
      <div style="flex:1;min-width:220px">
        <div style="color:var(--faint);font-size:12.5px;margin-bottom:8px">更换封面（上传后会覆盖 ${coverPath.split("/").pop()}）</div>
        <input type="file" name="cover_file" accept="image/*" style="color:var(--muted);font-size:13px">
      </div>
    </div>
    <div class="hint">
      <b>字段说明：</b>
      <code>title</code> 文章大标题 ·
      <code>published</code> 日期 ·
      <code>description</code> 首页卡片显示的那段简介（角色文案改这里） ·
      <code>tags</code> 标签 ·
      <code>category</code> 分类 ·
      <code>image</code> 封面路径（一般不用动） ·
      <code>---</code> 以下是正文
    </div>
    <form method="POST" action="/__panel-x7k2/posts/save" enctype="multipart/form-data">
      <input type="hidden" name="path" value="${path}">
      <textarea class="md" name="content" spellcheck="false">${escapeHtml(content)}</textarea>
      <div class="form-actions">
        <button class="btn-save" type="submit">保存并发布</button>
        <a class="back" href="/__panel-x7k2/posts">返回列表</a>
      </div>
    </form>
  </div>`;
}

function adminHtml(rows, pageviews, maxUsers) {
  const trs = rows
    .map((r) => {
      const d = JSON.parse(r.value);
      const first = formatTime(d.firstSeen);
      const last = formatTime(d.lastSeen);
      const locText = formatLocation(d.location);
      const locClass = locText === "未知" ? "loc unknown" : "loc";
      return `<tr><td class="name">${escapeHtml(r.name)}</td><td class="time">${first}</td><td class="time">${last}</td><td><span class="count-badge">${d.count}</span></td><td><span class="${locClass}">${escapeHtml(locText)}</span></td></tr>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理面板 · Firefly</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='8' fill='%237ee787'/%3E%3C/svg%3E">
<style>
  :root{
    --bg:#0c120e;--surface:#131c17;--surface-2:#182420;--border:#26362c;
    --glow:#7ee787;--green:#3fb950;--text:#e6f0e8;--muted:#9bb0a1;--faint:#6b7f73;
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    background:
      radial-gradient(900px 420px at 85% -10%, rgba(126,231,135,.10), transparent 60%),
      radial-gradient(700px 380px at -10% 110%, rgba(63,185,80,.08), transparent 60%),
      var(--bg);
    color:var(--text);
    font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
    min-height:100vh;padding:30px 20px 48px;
  }
  .wrap{max-width:980px;margin:0 auto}
  .firefly{
    position:fixed;top:64px;right:9%;width:10px;height:10px;border-radius:50%;
    background:var(--glow);
    box-shadow:0 0 12px 3px rgba(126,231,135,.7),0 0 38px 10px rgba(126,231,135,.25);
    animation:float 7s ease-in-out infinite;z-index:5;
  }
  @keyframes float{
    0%,100%{transform:translate(0,0);opacity:.85}
    35%{transform:translate(-18px,26px);opacity:1}
    70%{transform:translate(10px,48px);opacity:.6}
  }
  @media (prefers-reduced-motion:reduce){.firefly{animation:none}}
  header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
  h1{
    font-family:"Noto Serif SC","Songti SC","STSong","SimSun",serif;
    font-size:30px;font-weight:600;margin:0;letter-spacing:2px;
  }
  h1 .dot{color:var(--glow)}
  .sub{color:var(--faint);font-size:13px;letter-spacing:1px}
  .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:26px 0 28px}
  .image-bg{position:relative;overflow:hidden;border:1px solid var(--border)}
  .image-bg::before{
    content:"";position:absolute;inset:0;z-index:0;
    background-size:cover;background-position:center top;
    transform:scale(1.03);filter:blur(0) brightness(.9) saturate(1.06);
  }
  .image-bg::after{
    content:"";position:absolute;inset:0;z-index:0;
    background:linear-gradient(150deg,rgba(12,28,19,.3),rgba(8,16,11,.2));
  }
  .image-bg > *{position:relative;z-index:1}
  .stat{border-radius:14px;padding:34px 32px}
  .stat.bg-1::before{background-image:url("/panel-bg/bg-1.jpg");background-position:center 22%}
  .stat.bg-2::before{background-image:url("/panel-bg/bg-2.jpg");background-position:center 22%}
  .stat .num{
    font-family:Georgia,"Times New Roman",serif;font-size:60px;font-weight:700;
    color:var(--glow);line-height:1.1;
    text-shadow:0 2px 16px rgba(0,0,0,.75),0 0 26px rgba(126,231,135,.45);
  }
  .stat .label{color:var(--muted);font-size:15px;margin-top:12px;letter-spacing:2px}
  .panel{border-radius:16px;background:var(--surface)}
  .quota-box{border-radius:16px;background:var(--surface);border:1px solid var(--border);margin-bottom:22px;overflow:hidden}
  .q-title{
    padding:17px 22px;border-bottom:1px solid var(--border);color:var(--muted);
    font-size:15px;letter-spacing:2px;display:flex;align-items:center;gap:9px;background:rgba(9,16,12,.72);
  }
  .q-title::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px rgba(63,185,80,.8)}
  .q-body{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .q-info{font-size:14.5px;color:var(--muted)}
  .q-info b{color:var(--glow);font-variant-numeric:tabular-nums}
  .q-warn{color:#e89a8c;margin-left:6px}
  .q-form{display:flex;gap:10px}
  .q-form input{
    width:110px;padding:10px 12px;border-radius:9px;font-size:15px;color:var(--text);
    background:rgba(8,14,11,.7);border:1px solid rgba(126,231,135,.22);outline:none;
  }
  .q-form input:focus{border-color:var(--glow);box-shadow:0 0 0 3px rgba(126,231,135,.14)}
  .q-form button{
    padding:10px 18px;border:0;border-radius:9px;cursor:pointer;
    background:var(--green);color:#08130b;font-size:14px;font-weight:600;letter-spacing:1px;
  }
  .q-form button:hover{filter:brightness(1.08)}
  @media (max-width:600px){.q-body{flex-direction:column;align-items:stretch}.q-form{justify-content:flex-end}}
  .panel.bg-3::before{background-image:url("/panel-bg/bg-3.jpg");background-position:center top;transform:scale(1)}
  .panel-title{
    padding:19px 22px;border-bottom:1px solid var(--border);color:var(--muted);
    font-size:15px;letter-spacing:2px;display:flex;align-items:center;gap:9px;
    background:rgba(9,16,12,.72);
  }
  .panel-title::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px rgba(63,185,80,.8)}
  .table-scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:640px}
  col.c-name{width:18%}col.c-time{width:27%}col.c-count{width:12%}col.c-loc{width:16%}
  th,td{padding:18px 20px;text-align:left;font-size:15px}
  th{
    color:var(--muted);font-weight:500;font-size:13px;letter-spacing:1px;
    background:rgba(20,30,25,.92);border-bottom:1px solid var(--border);
  }
  td{border-bottom:1px solid rgba(38,54,44,.7);color:var(--text);text-shadow:0 1px 7px rgba(0,0,0,.85)}
  tbody tr{transition:background .18s;background:rgba(9,16,12,.72)}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:rgba(126,231,135,.18)}
  .name{font-weight:600}
  .time{color:var(--muted);font-variant-numeric:tabular-nums}
  .count-badge{
    display:inline-block;min-width:30px;text-align:center;padding:3px 9px;border-radius:999px;
    background:rgba(63,185,80,.16);color:var(--glow);font-variant-numeric:tabular-nums;
  }
  .loc{
    display:inline-block;padding:4px 11px;border-radius:8px;font-size:13px;
    border:1px solid rgba(126,231,135,.38);color:var(--glow);
    background:rgba(126,231,135,.09);
  }
  .loc.unknown{border-color:var(--border);color:var(--faint);background:transparent}
  footer{margin-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
  .back{
    color:var(--green);text-decoration:none;font-size:14px;padding:9px 18px;
    border:1px solid var(--border);border-radius:10px;transition:all .18s;cursor:pointer;
    background:rgba(19,28,23,.7);
  }
  .back:hover{border-color:var(--green);background:rgba(63,185,80,.14)}
  .note{color:var(--faint);font-size:12.5px}
  .nav-tabs{display:flex;gap:8px;margin:22px 0 6px;flex-wrap:wrap}
  .nav-tabs a{
    padding:9px 18px;border-radius:10px;font-size:14px;color:var(--muted);
    background:var(--surface);border:1px solid var(--border);text-decoration:none;
    letter-spacing:1px;transition:all .18s;
  }
  .nav-tabs a:hover{color:var(--glow);border-color:rgba(126,231,135,.4)}
  .nav-tabs a.active{color:#08130b;background:var(--green);border-color:var(--green);font-weight:600}
  .post-list{display:grid;gap:12px;margin-top:18px}
  .post-item{
    display:flex;justify-content:space-between;align-items:center;gap:14px;
    padding:18px 22px;border-radius:14px;background:var(--surface);
    border:1px solid var(--border);text-decoration:none;color:var(--text);
    transition:all .18s;
  }
  .post-item:hover{border-color:var(--green);transform:translateY(-1px)}
  .post-item .lbl{font-size:16px;font-weight:600}
  .post-item .pth{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--faint);margin-top:5px}
  .post-item .go{color:var(--green);font-size:14px}
  textarea.md{
    width:100%;min-height:420px;padding:14px 16px;border-radius:12px;
    background:rgba(8,14,11,.85);border:1px solid var(--border);color:var(--text);
    font-family:ui-monospace,Menlo,Consolas,"Courier New",monospace;font-size:13.5px;
    line-height:1.6;outline:none;resize:vertical;
  }
  textarea.md:focus{border-color:var(--glow);box-shadow:0 0 0 3px rgba(126,231,135,.14)}
  .btn-save{
    padding:11px 26px;border:0;border-radius:10px;cursor:pointer;
    background:var(--green);color:#08130b;font-size:14px;font-weight:600;letter-spacing:1px;
  }
  .btn-save:hover{filter:brightness(1.08)}
  .form-actions{display:flex;gap:12px;align-items:center;margin-top:16px}
  .msg{padding:11px 16px;border-radius:10px;margin:14px 0;font-size:14px}
  .msg.ok{background:rgba(63,185,80,.15);color:var(--glow);border:1px solid rgba(63,185,80,.4)}
  .msg.err{background:rgba(232,110,100,.15);color:#ff9b8a;border:1px solid rgba(232,110,100,.4)}
  @media (max-width:600px){
    body{padding:22px 14px 40px}h1{font-size:25px}
    .stats{gap:12px}.stat{padding:24px}.stat .num{font-size:46px}
  }
</style></head>
<body>
<div class="firefly" aria-hidden="true"></div>
<div class="wrap">
  <header>
    <h1>管理面板<span class="dot"> · </span>萤火之夜</h1>
    <div class="sub">FIREFLY ADMIN · 访客记录</div>
  </header>
  <nav class="nav-tabs">
    <a href="/__panel-x7k2" class="active">访客记录</a>
    <a href="/__panel-x7k2/posts">文章编辑</a>
  </nav>
  <section class="stats">
    <div class="stat image-bg bg-1"><div><div class="num">${pageviews}</div><div class="label">总进站次数</div></div></div>
    <div class="stat image-bg bg-2"><div><div class="num">${rows.length}</div><div class="label">访客数</div></div></div>
  </section>
  <section class="quota-box">
    <div class="q-title">注册名额管理</div>
    <div class="q-body">
      <div class="q-info">当前已注册 <b>${rows.length}</b> 个账号，上限 <b>${maxUsers}</b> 个
        ${rows.length >= maxUsers ? '<span class="q-warn">（已满，新用户无法注册）</span>' : ""}
      </div>
      <form method="POST" action="/__panel-x7k2" class="q-form">
        <input type="number" name="max_users" min="1" max="9999" value="${maxUsers}" required>
        <button type="submit">保存上限</button>
      </form>
    </div>
  </section>
  <section class="panel image-bg bg-3">
    <div class="panel-title">访客名单</div>
    <div class="table-scroll">
      <table>
        <colgroup><col class="c-name"><col class="c-time"><col class="c-time"><col class="c-count"><col class="c-loc"></colgroup>
        <thead><tr><th>昵称</th><th>首次访问</th><th>最后访问</th><th>次数</th><th>登录地点</th></tr></thead>
        <tbody>${trs || '<tr><td colspan="5">暂无访客记录</td></tr>'}</tbody>
      </table>
    </div>
  </section>
  <footer>
    <a class="back" href="/">返回首页</a>
    <div class="note">仅管理员可见 · 数据实时读取自 KV</div>
  </footer>
</div>
</body></html>`;
}

export default {
  async fetch(request, env) {
    if (!env.AUTH_PASS || !env.AUTH_SECRET || !env.FF_DATA) {
      return new Response("Auth not configured", { status: 500 });
    }
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // ---------- 登录 ----------
    if (url.pathname === "/__login") {
      if (request.method === "POST") {
        // 限流：失败次数检查
        const failKey = `fail:${ip}`;
        const failCount = parseInt((await env.FF_DATA.get(failKey)) || "0", 10);
        if (failCount >= MAX_FAIL) {
          return new Response(
            loginHtml("失败次数过多，请 10 分钟后再试"),
            {
              status: 429,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }

        let form;
        try {
          form = await request.formData();
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const name = String(form.get("name") || "").trim();
        const password = String(form.get("password") || "");

        if (!validName(name)) {
          return new Response(
            loginHtml("昵称无效（1–20 位，中英文/数字/_-）"),
            {
              status: 400,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }

        const isAdmin = name === ADMIN_NAME;
        const expectedPass = isAdmin ? env.ADMIN_PASS : env.AUTH_PASS;
        if (isAdmin && !env.ADMIN_PASS) {
          return new Response(loginHtml("管理员未配置"), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (password !== expectedPass) {
          await env.FF_DATA.put(failKey, String(failCount + 1), {
            expirationTtl: FAIL_TTL,
          });
          return new Response(loginHtml("昵称或密码错误"), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // 普通用户：必须是已注册账号才放行并更新统计；admin 不进访客名单
        if (!isAdmin) {
          const vKey = `visitor:${name}`;
          const existing = await env.FF_DATA.get(vKey);
          // existing 必须是可解析的 JSON 才算有效账号；损坏/空值视为未注册
          let data = null;
          if (existing) {
            try {
              data = JSON.parse(existing);
              if (!data || typeof data !== "object") data = null;
            } catch {
              data = null;
            }
          }
          if (!data) {
            if (existing) await env.FF_DATA.delete(vKey); // 清理损坏残留
            return new Response(loginHtml("该昵称尚未注册，请先注册账号"), {
              status: 403,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          data.lastSeen = now;
          data.count += 1;
          // 临时用 IP 翻译中文地名，只存地名、不存 IP
          data.location = await geoLocate(request, ip);
          await env.FF_DATA.put(vKey, JSON.stringify(data));
          const pv =
            parseInt((await env.FF_DATA.get("pageviews")) || "0", 10) + 1;
          await env.FF_DATA.put("pageviews", String(pv));
        }

        const exp = String(now + SESSION_TTL);
        const role = isAdmin ? "admin" : "user";
        const sig = await sign(env, `${exp}.${role}.${name}`);
        const cookieVal = `${exp}.${role}.${encodeURIComponent(name)}.${sig}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: isAdmin ? "/__panel-x7k2" : "/",
            "Set-Cookie": `${COOKIE_NAME}=${cookieVal}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
          },
        });
      }
      return new Response(loginHtml(""), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ---------- 注册 ----------
    if (url.pathname === "/__register") {
      const maxUsers = await getMaxUsers(env);
      const current = (await env.FF_DATA.list({ prefix: "visitor:" })).keys.length;

      if (request.method === "POST") {
        // 限流：失败次数检查
        const failKey = `fail:${ip}`;
        const failCount = parseInt((await env.FF_DATA.get(failKey)) || "0", 10);
        if (failCount >= MAX_FAIL) {
          return new Response(
            registerHtml("失败次数过多，请 10 分钟后再试", current, maxUsers),
            { status: 429, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }

        let form;
        try {
          form = await request.formData();
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const name = String(form.get("name") || "").trim();
        const password = String(form.get("password") || "");

        if (!validName(name)) {
          return new Response(
            registerHtml("昵称无效（1–20 位，中英文/数字/_-）", current, maxUsers),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        if (name === ADMIN_NAME) {
          return new Response(
            registerHtml("该昵称为系统保留名，请换一个", current, maxUsers),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        if (password !== env.AUTH_PASS) {
          await env.FF_DATA.put(failKey, String(failCount + 1), {
            expirationTtl: FAIL_TTL,
          });
          return new Response(
            registerHtml("访问密码错误", current, maxUsers),
            { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }

        const vKey = `visitor:${name}`;
        // 只有已存在且数据有效的才算"已占用"；损坏残留允许覆盖重建
        const existingReg = await env.FF_DATA.get(vKey);
        if (existingReg) {
          let valid = false;
          try {
            const d = JSON.parse(existingReg);
            if (d && typeof d === "object" && d.firstSeen) valid = true;
          } catch {
            valid = false;
          }
          if (valid) {
            return new Response(
              registerHtml("该昵称已被占用，请换一个或直接登录", current, maxUsers),
              { status: 409, headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
          }
          await env.FF_DATA.delete(vKey); // 清掉损坏残留，继续注册
        }
        if (current >= maxUsers) {
          return new Response(
            registerHtml("注册名额已满", current, maxUsers),
            { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }

        // 创建账号：沿用 visitor 结构，只存统计与中文地名，不存密码
        const location = await geoLocate(request, ip);
        await env.FF_DATA.put(
          vKey,
          JSON.stringify({ firstSeen: now, lastSeen: now, count: 1, location }),
        );
        const pv = parseInt((await env.FF_DATA.get("pageviews")) || "0", 10) + 1;
        await env.FF_DATA.put("pageviews", String(pv));

        // 注册成功即登录，颁发 Cookie
        const exp = String(now + SESSION_TTL);
        const role = "user";
        const sig = await sign(env, `${exp}.${role}.${name}`);
        const cookieVal = `${exp}.${role}.${encodeURIComponent(name)}.${sig}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": `${COOKIE_NAME}=${cookieVal}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
          },
        });
      }

      return new Response(registerHtml("", current, maxUsers), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ---------- 文章编辑（GitHub 直推） ----------
    if (url.pathname === "/__panel-x7k2/posts" ||
        url.pathname === "/__panel-x7k2/posts/edit" ||
        url.pathname === "/__panel-x7k2/posts/save") {
      const session = await verifySession(env, request.headers.get("Cookie"));
      if (!session || session.role !== "admin") {
        return new Response(null, { status: 302, headers: { Location: "/__login" } });
      }
      if (!env.GH_TOKEN) {
        return new Response(adminShell("文章编辑", "FIREFLY ADMIN · POSTS",
          `<div class="msg err">未配置 GH_TOKEN 环境变量。请到 Cloudflare Worker → Settings → Variables 加一个 GH_TOKEN（GitHub Personal Access Token，repo 权限）。</div>`, "posts"),
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // POST 保存
      if (url.pathname === "/__panel-x7k2/posts/save" && request.method === "POST") {
        let form;
        try { form = await request.formData(); } catch { return new Response("Bad", { status: 400 }); }
        const path = String(form.get("path") || "");
        const content = String(form.get("content") || "");
        const known = EDITABLE_POSTS.find((p) => p.path === path);
        if (!known) return new Response("非法路径", { status: 400 });
        try {
          // 1. 若上传了新封面，先传图
          const coverFile = form.get("cover_file");
          if (coverFile && typeof coverFile === "object" && coverFile.size > 0) {
            const buf = new Uint8Array(await coverFile.arrayBuffer());
            // 取远程 cover 的 sha
            let coverSha = null;
            try { coverSha = (await ghGetRaw(env, known.cover)).sha; } catch {}
            await ghPutBinary(env, known.cover, buf, coverSha, `chore: 替换封面 ${known.label}`);
          }
          // 2. 推 md
          const { sha } = await ghGetRaw(env, path);
          await ghPut(env, path, content, sha, `edit: ${known.label}`);
          return new Response(null, { status: 303, headers: { Location: "/__panel-x7k2/posts?ok=1" } });
        } catch (e) {
          return new Response(adminShell("文章编辑", "FIREFLY ADMIN · POSTS",
            postsListHtml("", "保存失败：" + (e.message || e)), "posts"),
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
      }

      // GET 编辑页
      if (url.pathname === "/__panel-x7k2/posts/edit") {
        const path = url.searchParams.get("path") || "";
        const known = EDITABLE_POSTS.find((p) => p.path === path);
        if (!known) return new Response("非法路径", { status: 400 });
        try {
          const { content } = await ghGetRaw(env, path);
          return new Response(adminShell("编辑文章", "FIREFLY ADMIN · POSTS",
            postsEditHtml(path, known.label, content, known.cover), "posts"),
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e) {
          return new Response(adminShell("编辑文章", "FIREFLY ADMIN · POSTS",
            postsListHtml("", "读取失败：" + (e.message || e)), "posts"),
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
      }

      // GET 列表
      const ok = url.searchParams.get("ok") === "1";
      return new Response(adminShell("文章编辑", "FIREFLY ADMIN · POSTS",
        postsListHtml(ok ? "已保存，CF 正在重建（约 1 分钟生效）" : ""), "posts"),
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ---------- 管理面板 ----------
    if (url.pathname === "/__panel-x7k2") {
      const session = await verifySession(
        env,
        request.headers.get("Cookie"),
      );
      if (!session || session.role !== "admin") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/__login" },
        });
      }
      const maxUsers = await getMaxUsers(env);

      // 保存人数上限（POST 表单）
      if (request.method === "POST") {
        let form;
        try {
          form = await request.formData();
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const v = parseInt(String(form.get("max_users") || ""), 10);
        if (!Number.isFinite(v) || v < 1 || v > 9999) {
          return new Response("上限必须是 1–9999 的整数", { status: 400 });
        }
        await env.FF_DATA.put(MAX_USERS_KEY, String(v));
        return new Response(null, {
          status: 303,
          headers: { Location: "/__panel-x7k2" },
        });
      }

      const listed = await env.FF_DATA.list({ prefix: "visitor:" });
      const rows = [];
      for (const k of listed.keys) {
        const keyName = k.name.replace(/^visitor:/, "");
        const value = await env.FF_DATA.get(k.name);
        rows.push({ name: keyName, value });
      }
      const pageviews = (await env.FF_DATA.get("pageviews")) || "0";
      return new Response(adminHtml(rows, pageviews, maxUsers), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ---------- 其余请求 ----------
    const session = await verifySession(env, request.headers.get("Cookie"));
    if (!session) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/__login" },
      });
    }
    const assetResp = await env.ASSETS.fetch(request);
    // 仅管理员 + 仅 HTML 页面：注入"回到管理面板"悬浮入口；其他资源与访客原样透传
    if (
      session.role === "admin" &&
      assetResp.headers.get("Content-Type")?.includes("text/html")
    ) {
      const html = await assetResp.text();
      const button = adminReentryHtml();
      const injected = html.includes("</body>")
        ? html.replace("</body>", `${button}</body>`)
        : html + button;
      const newHeaders = new Headers(assetResp.headers);
      newHeaders.delete("content-length"); // 长度已变，让运行时重新计算
      return new Response(injected, {
        status: assetResp.status,
        headers: newHeaders,
      });
    }
    return assetResp;
  },
};
