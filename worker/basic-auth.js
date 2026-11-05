const COOKIE_NAME = "ff_auth";
const SESSION_TTL = 7 * 24 * 60 * 60;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需要密码</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee}
form{background:#1e1e1e;padding:32px;border-radius:12px;display:flex;flex-direction:column;gap:12px;width:280px}
input{padding:10px;border-radius:6px;border:1px solid #333;background:#2a2a2a;color:#fff}
button{padding:10px;border:0;border-radius:6px;background:#4f8cff;color:#fff;cursor:pointer}</style></head>
<body><form method="POST" action="/__login"><h3>请输入访问密码</h3>
<input type="password" name="password" placeholder="密码" autofocus><button type="submit">进入</button></form></body></html>`;

async function sign(env, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function validSession(env, cookieHeader) {
  const m = (cookieHeader || "").match(new RegExp(COOKIE_NAME + "=([^;]+)"));
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!exp || !sig) return false;
  if (parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return false;
  return (await sign(env, exp)) === sig;
}

export default {
  async fetch(request, env) {
    if (!env.AUTH_PASS || !env.AUTH_SECRET) {
      return new Response("Auth not configured", { status: 500 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/__login") {
      if (request.method === "POST") {
        let form;
        try { form = await request.formData(); } catch { return new Response("Bad request", { status: 400 }); }
        if (String(form.get("password") || "") === env.AUTH_PASS) {
          const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
          const sig = await sign(env, exp);
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": `${COOKIE_NAME}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`,
            },
          });
        }
        return new Response(LOGIN_HTML, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(LOGIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (!(await validSession(env, request.headers.get("Cookie"))) ) {
      return new Response(null, { status: 302, headers: { "Location": "/__login" } });
    }
    return env.ASSETS.fetch(request);
  },
};
