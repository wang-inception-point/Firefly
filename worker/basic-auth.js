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

function adminHtml(rows, pageviews) {
  const trs = rows
    .map((r) => {
      const d = JSON.parse(r.value);
      const first = new Date(d.firstSeen * 1000).toLocaleString("zh-CN", {
        hour12: false,
      });
      const last = new Date(d.lastSeen * 1000).toLocaleString("zh-CN", {
        hour12: false,
      });
      return `<tr><td>${escapeHtml(r.name)}</td><td>${first}</td><td>${last}</td><td>${d.count}</td><td>${escapeHtml(formatLocation(d.location))}</td></tr>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理面板</title>
<style>body{font-family:sans-serif;background:#111;color:#eee;margin:0;padding:24px}
table{border-collapse:collapse;width:100%;max-width:1000px;margin-top:12px}
th,td{border:1px solid #333;padding:8px 10px;text-align:left;font-size:14px}
th{background:#1e1e1e}
a{color:#4f8cff}</style></head><body>
<h2>管理面板</h2>
<p>总进站次数：<strong>${pageviews}</strong>　访客数：<strong>${rows.length}</strong></p>
<table><thead><tr><th>昵称</th><th>首次访问</th><th>最后访问</th><th>访问次数</th><th>登录地点</th></tr></thead>
<tbody>${trs || '<tr><td colspan="5">暂无访客记录</td></tr>'}</tbody></table>
<p><a href="/">返回首页</a></p></body></html>`;
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
    return env.ASSETS.fetch(request);
  },
};
