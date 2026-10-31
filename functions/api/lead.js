// BizPilot 领资料表单：提交接口（Cloudflare Pages Function）
//
// POST /api/lead   { magnet, name, email, consent, consent_text, hp, utm, page }
//   1. 存进 D1（绑定名 DB，表 leads）
//   2. 有 GHL_TOKEN 与 GHL_LOCATION_ID 时：按邮箱 upsert 联系人，加标签与备注
//      标签「bizpilot-12条做法-已领取」用来触发 GHL 工作流，把清单发到客户邮箱
//      勾选了营销邮件同意的，另加标签「bizpilot-同意营销邮件」
//   3. LEAD_TO_DRIVE = "1" 且配了 GAS_URL、GAS_KEY 时：把这一行交给 Apps Script 记进 Drive 表格
//      （要先给 Apps Script 加 kind=lead 的处理并重新部署，否则不要打开这个开关）
//
// 任何一步出错都不挡住访客：只要邮箱有效就返回 ok，错误写进 D1 与日志。
// 复用开户问卷已配置的变量：DB、GHL_TOKEN、GHL_LOCATION_ID、GAS_URL、GAS_KEY。

const MAGNETS = {
  "ai-team-12": {
    tag: "bizpilot-12条做法-已领取",
    source: "BizPilot 12条做法领取页",
    label: "《12 条做法》清单",
  },
};
const CONSENT_TAG = "bizpilot-同意营销邮件";
const MAX_BYTES = 8 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  magnet TEXT NOT NULL,
  created_at TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  consent_text TEXT,
  page TEXT,
  utm_json TEXT,
  country TEXT,
  ghl_contact_id TEXT,
  ghl_status TEXT,
  drive_status TEXT
)`;

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function ghl(env, method, path, body) {
  const base = env.GHL_BASE || "https://services.leadconnectorhq.com"; // GHL_BASE 只在本地测试时覆盖
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${env.GHL_TOKEN}`,
      version: "2021-07-28",
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let data = {};
  try { data = JSON.parse(await res.text()); } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function syncGhl(env, lead, m) {
  const up = await ghl(env, "POST", "/contacts/upsert", {
    locationId: env.GHL_LOCATION_ID,
    email: lead.email,
    ...(lead.name ? { firstName: lead.name } : {}),
    source: m.source,
  });
  const id = up.data && up.data.contact && up.data.contact.id;
  if (!up.ok || !id) return { contactId: null, status: `upsert 失败 HTTP ${up.status}` };

  const tags = [m.tag];
  if (lead.consent) tags.push(CONSENT_TAG);
  const t = await ghl(env, "POST", `/contacts/${id}/tags`, { tags });
  const note = [
    `领取 ${m.label}（${lead.page || ""}）`,
    `时间：${lead.created_at}`,
    lead.consent ? `同意营销邮件：是。勾选文字：${lead.consent_text}` : "同意营销邮件：否（只发这一封清单）",
    Object.keys(lead.utm).length ? `来源参数：${JSON.stringify(lead.utm)}` : "",
  ].filter(Boolean).join("\n");
  const n = await ghl(env, "POST", `/contacts/${id}/notes`, { body: note });
  const base = up.data.new ? "新建联系人" : "按邮箱匹配，已更新";
  return { contactId: id, status: t.ok && n.ok ? base : `${base}；标签 HTTP ${t.status}，备注 HTTP ${n.status}` };
}

async function toDrive(env, lead) {
  const url = `${env.GAS_URL}?key=${encodeURIComponent(env.GAS_KEY)}&kind=lead`;
  let res = await fetch(url, {
    method: "POST",
    body: JSON.stringify(lead),
    headers: { "content-type": "text/plain; charset=utf-8" },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    res = await fetch(res.headers.get("location"), { redirect: "follow" });
  }
  let out = {};
  try { out = JSON.parse(await res.text()); } catch {}
  return out.ok ? "已记入 Drive" : `Drive 失败：${clip(out.error || `HTTP ${res.status}`, 200)}`;
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) return json({ ok: false, error: "内容太大。" }, 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ ok: false, error: "内容太大。" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "提交格式有误，请刷新页面后再试。" }, 400);
  }

  const m = MAGNETS[body.magnet];
  if (!m) return json({ ok: false, error: "资料类型不对。" }, 400);
  if (body.hp) return json({ ok: true }); // 蜜罐有值：假装成功，不入库

  const email = clip(body.email, 200).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "请填写有效的邮箱。" }, 400);

  const utm = {};
  if (body.utm && typeof body.utm === "object") {
    for (const [k, v] of Object.entries(body.utm).slice(0, 6)) utm[clip(k, 30)] = clip(v, 100);
  }
  const lead = {
    id: crypto.randomUUID(),
    magnet: body.magnet,
    created_at: new Date().toISOString(),
    name: clip(body.name, 60).trim(),
    email,
    consent: body.consent === true,
    consent_text: body.consent === true ? clip(body.consent_text, 300) : "",
    page: clip(body.page, 100),
    utm,
    country: clip(request.cf && request.cf.country, 4),
  };

  // 同一邮箱 10 分钟内重复提交同一份资料：不重复推 GHL、不重复发邮件
  let duplicate = false;
  if (env.DB) {
    try {
      await env.DB.prepare(SCHEMA).run();
      const prev = await env.DB.prepare(
        "SELECT created_at FROM leads WHERE email = ?1 AND magnet = ?2 ORDER BY created_at DESC LIMIT 1"
      ).bind(email, lead.magnet).first();
      duplicate = Boolean(prev && Date.now() - Date.parse(prev.created_at) < 10 * 60 * 1000);
      await env.DB.prepare(
        `INSERT INTO leads (id, magnet, created_at, name, email, consent_marketing, consent_text, page, utm_json, country, ghl_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      ).bind(
        lead.id, lead.magnet, lead.created_at, lead.name, email, lead.consent ? 1 : 0,
        lead.consent_text, lead.page, JSON.stringify(utm), lead.country, duplicate ? "重复提交，跳过" : null
      ).run();
    } catch (e) {
      console.error("D1 failed", e);
    }
  }

  if (!duplicate) {
    // 访客不用等 GHL 与 Drive，先拿到下载按钮
    waitUntil((async () => {
      let ghlRes = null, driveStatus = null;
      if (env.GHL_TOKEN && env.GHL_LOCATION_ID) {
        try { ghlRes = await syncGhl(env, lead, m); } catch (e) { ghlRes = { contactId: null, status: `GHL 出错：${clip(e && e.message || e, 200)}` }; }
      }
      if (env.LEAD_TO_DRIVE === "1" && env.GAS_URL && env.GAS_KEY) {
        try { driveStatus = await toDrive(env, { ...lead, ghl_status: ghlRes && ghlRes.status }); } catch (e) { driveStatus = `Drive 出错：${clip(e && e.message || e, 200)}`; }
      }
      if (env.DB && (ghlRes || driveStatus)) {
        try {
          await env.DB.prepare("UPDATE leads SET ghl_contact_id = ?2, ghl_status = ?3, drive_status = ?4 WHERE id = ?1")
            .bind(lead.id, ghlRes && ghlRes.contactId, ghlRes && clip(ghlRes.status, 300), driveStatus).run();
        } catch (e) {
          console.error("D1 update failed", e);
        }
      }
    })());
  }

  return json({ ok: true });
}

export async function onRequest() {
  return json({ ok: false, error: "method not allowed" }, 405);
}
