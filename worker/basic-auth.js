const COOKIE_NAME = "ff_auth";
const SESSION_TTL = 7 * 24 * 60 * 60;
const ADMIN_NAME = "Anna";
const MAX_NAME_LEN = 20;
const MAX_FAIL = 5;
const FAIL_TTL = 600; // 失败锁定窗口 10 分钟
const GEO_TIMEOUT = 3500; // 地理库查询超时 3.5 秒

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

function loginHtml(error) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee}
form{background:#1e1e1e;padding:32px;border-radius:12px;display:flex;flex-direction:column;gap:12px;width:280px}
input{padding:10px;border-radius:6px;border:1px solid #333;background:#2a2a2a;color:#fff}
button{padding:10px;border:0;border-radius:6px;background:#4f8cff;color:#fff;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin:0}</style></head>
<body><form method="POST" action="/__login"><h3>请输入昵称和访问密码</h3>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<input type="text" name="name" placeholder="昵称" maxlength="20" autofocus required>
<input type="password" name="password" placeholder="密码" required>
<button type="submit">进入</button></form></body></html>`;
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

function adminHtml(rows, pageviews) {
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
  <section class="stats">
    <div class="stat image-bg bg-1"><div><div class="num">${pageviews}</div><div class="label">总进站次数</div></div></div>
    <div class="stat image-bg bg-2"><div><div class="num">${rows.length}</div><div class="label">访客数</div></div></div>
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

        // 记录访客（admin 不进访客名单）
        if (!isAdmin) {
          const vKey = `visitor:${name}`;
          const existing = await env.FF_DATA.get(vKey);
          let data;
          if (existing) {
            data = JSON.parse(existing);
            data.lastSeen = now;
            data.count += 1;
          } else {
            data = { firstSeen: now, lastSeen: now, count: 1 };
          }
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
      const listed = await env.FF_DATA.list({ prefix: "visitor:" });
      const rows = [];
      for (const k of listed.keys) {
        const keyName = k.name.replace(/^visitor:/, "");
        const value = await env.FF_DATA.get(k.name);
        rows.push({ name: keyName, value });
      }
      const pageviews = (await env.FF_DATA.get("pageviews")) || "0";
      return new Response(adminHtml(rows, pageviews), {
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
