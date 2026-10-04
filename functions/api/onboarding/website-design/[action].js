// BizPilot 网站设计开户问卷：提交接口（Cloudflare Pages Function）
//
// POST /api/onboarding/website-design/answers   小 JSON：答案、可读版答案、文件清单
//   -> 存进 D1（绑定名 DB），返回提交编号 id
// POST /api/onboarding/website-design/files?id= 完整 JSON：答案 + base64 文件
//   -> 原样转交 Google Apps Script（存 Drive、发邮件、可选通知 GHL），回写 D1 状态
//
// 需要在 Cloudflare Pages 项目里配置（Settings > Variables and Secrets / Bindings）：
//   DB       D1 数据库绑定（建议库名 bizpilot-onboarding）
//   GAS_URL  Apps Script 网页应用地址（.../exec）
//   GAS_KEY  与 Apps Script 里 INGEST_KEY 相同的密钥（加密保存，不写进任何文件）

const SERVICE = "website-design";
const MAX_ANSWERS_BYTES = 400 * 1024;
const MAX_FILES_BYTES = 40 * 1024 * 1024;
const ID_RE = /^[0-9a-f-]{36}$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS onboarding_submissions (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  form_version TEXT,
  created_at TEXT NOT NULL,
  business TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  answers_json TEXT,
  readable_json TEXT,
  files_manifest TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  drive_folder_url TEXT,
  drive_doc_url TEXT,
  synced_at TEXT,
  last_error TEXT
)`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function configured(env) {
  return Boolean(env.GAS_URL && env.GAS_KEY);
}

async function ensureTable(env) {
  if (env.DB) await env.DB.prepare(SCHEMA).run();
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

async function handleAnswers(request, env) {
  if (!configured(env)) return json({ ok: false, configured: false }, 503);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_ANSWERS_BYTES) return json({ ok: false, error: "内容太大，请联系我们。" }, 413);

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_ANSWERS_BYTES) return json({ ok: false, error: "内容太大，请联系我们。" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "提交格式有误，请刷新页面后再试。" }, 400);
  }
  if (body.service !== SERVICE) return json({ ok: false, error: "问卷类型不对。" }, 400);

  const id = crypto.randomUUID();
  // 蜜罐字段有值时假装成功，不入库
  if (body.hp) return json({ ok: true, id });

  const c = body.contact || {};
  if (!c.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || "")) {
    return json({ ok: false, error: "请填写姓名和有效的邮箱。" }, 400);
  }

  if (env.DB) {
    try {
      await ensureTable(env);
      await env.DB.prepare(
        `INSERT INTO onboarding_submissions
         (id, service, form_version, created_at, business, contact_name, contact_email, contact_phone,
          answers_json, readable_json, files_manifest, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'received')`
      ).bind(
        id, SERVICE, clip(body.form_version, 40), new Date().toISOString(),
        clip(c.business, 200), clip(c.name, 120), clip(c.email, 200), clip(c.phone, 60),
        JSON.stringify(body.answers || {}), JSON.stringify(body.readable || []),
        JSON.stringify(body.files_manifest || [])
      ).run();
    } catch (e) {
      // 数据库出错不挡住客户：继续走 Drive 和邮件，错误记在日志里
      console.error("D1 insert failed", e);
    }
  }
  return json({ ok: true, id });
}

async function callAppsScript(env, id, payload) {
  const url = `${env.GAS_URL}?key=${encodeURIComponent(env.GAS_KEY)}&id=${encodeURIComponent(id)}`;
  let res = await fetch(url, {
    method: "POST",
    body: payload,
    headers: { "content-type": "text/plain; charset=utf-8" },
    redirect: "manual",
  });
  // Apps Script 处理完 POST 后用 302 指向结果页，结果要用 GET 去取
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    res = await fetch(res.headers.get("location"), { redirect: "follow" });
  }
  const text = await res.text();
  let out = {};
  try { out = JSON.parse(text); } catch { out = { ok: false, error: `Apps Script 返回了非 JSON（HTTP ${res.status}）` }; }
  return out;
}

async function handleFiles(request, env) {
  if (!configured(env)) return json({ ok: false, configured: false }, 503);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!ID_RE.test(id)) return json({ ok: false, error: "提交编号无效。" }, 400);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_FILES_BYTES) return json({ ok: false, error: "文件太大。" }, 413);

  if (env.DB) {
    try {
      await ensureTable(env);
      const row = await env.DB.prepare("SELECT status, attempts FROM onboarding_submissions WHERE id = ?1").bind(id).first();
      if (!row) return json({ ok: false, error: "找不到这份提交，请刷新页面后再提交一次。" }, 404);
      if (row.status === "synced") return json({ ok: true, already: true });
      if (row.attempts >= 5) return json({ ok: false, error: "重试次数太多，请直接联系我们。" }, 429);
      await env.DB.prepare("UPDATE onboarding_submissions SET attempts = attempts + 1 WHERE id = ?1").bind(id).run();
    } catch (e) {
      console.error("D1 lookup failed", e);
    }
  }

  // 不解析大文件，直接按原样转交，省 CPU
  const payload = await request.arrayBuffer();
  if (payload.byteLength > MAX_FILES_BYTES) return json({ ok: false, error: "文件太大。" }, 413);

  let out;
  try {
    out = await callAppsScript(env, id, payload);
  } catch (e) {
    out = { ok: false, error: String(e && e.message || e) };
  }

  if (env.DB) {
    try {
      if (out.ok) {
        await env.DB.prepare(
          "UPDATE onboarding_submissions SET status = 'synced', drive_folder_url = ?2, drive_doc_url = ?3, synced_at = ?4, last_error = NULL WHERE id = ?1"
        ).bind(id, clip(out.folderUrl, 300), clip(out.docUrl, 300), new Date().toISOString()).run();
      } else {
        await env.DB.prepare("UPDATE onboarding_submissions SET status = 'sync_failed', last_error = ?2 WHERE id = ?1")
          .bind(id, clip(out.error, 500)).run();
      }
    } catch (e) {
      console.error("D1 update failed", e);
    }
  }

  if (!out.ok) {
    console.error("Apps Script failed", id, out.error);
    return json({ ok: false, error: "存档没有完成，请再试一次。" }, 502);
  }
  return json({ ok: true });
}

export async function onRequestPost({ request, env, params }) {
  if (params.action === "answers") return handleAnswers(request, env);
  if (params.action === "files") return handleFiles(request, env);
  return json({ ok: false, error: "not found" }, 404);
}

export async function onRequest() {
  return json({ ok: false, error: "method not allowed" }, 405);
}
