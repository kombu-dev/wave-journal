/*
 * 「Googleでログイン」（src/google-auth.js）のテスト。6つのアプリで同じファイルを使う。
 * api.test.mjs の最後から呼ぶ（npm test / deploy:* で一緒に走る）。
 * Google のトークン窓口（oauth2.googleapis.com/token）は fetch を差し替えて模擬する。本物には一切つながない。
 *
 *   opts.createApp     d1-harness の createApp
 *   opts.root          アプリのフォルダ
 *   opts.check         makeChecker() の check
 *   opts.cookieName    セッション Cookie の名前（例 'wj_session'）
 *   opts.sessionPath   設定状況を返す API（例 '/api/session'）。応答に google:true/false が入る
 *   opts.protectedPath 合言葉（ログイン）が要る GET の API（例 '/api/entries'）
 *   opts.loginBody     合言葉ログイン（POST /api/login）に送る中身を作る関数。key => body
 *   opts.vars          そのほかアプリに渡す値（APP_ENV など）
 */
export async function runGoogleTests(opts) {
  const { createApp, root, check, cookieName, sessionPath, protectedPath } = opts;
  const loginBody = opts.loginBody || ((key) => ({ key }));
  const APP_KEY = 'google-test-key';
  const base = { APP_ENV: 'test', APP_KEY, ...(opts.vars || {}) };
  const G = { GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret', OWNER_EMAIL: 'Owner@Example.com, second@example.com' };

  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const idToken = (claims) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({
    iss: 'https://accounts.google.com', aud: G.GOOGLE_CLIENT_ID, email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), sub: '123', ...claims,
  })}.sig`;

  async function send(app, pathname, { cookie = '', method = 'GET', body } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.worker.fetch(new Request('https://test.local' + pathname, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
    }), app.env, app.ctx);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML など */ }
    return { status: res.status, text, json, headers: res.headers, cookies: res.headers.getSetCookie() };
  }
  const cookieOf = (cookies, name) => {
    const c = cookies.find((x) => x.startsWith(name + '='));
    return c ? c.split(';')[0] : null;
  };

  /** Google のトークン窓口を模擬する。respond(body) が返したものを応答にする */
  const realFetch = globalThis.fetch;
  let tokenCalls = [];
  function mockGoogle(respond) {
    tokenCalls = [];
    globalThis.fetch = async (input, init = {}) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(String(init.body));
        tokenCalls.push(params);
        const r = respond(params);
        return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('テスト中に想定外の外部通信: ' + u);
    };
  }

  console.log('\n[Googleでログイン]');
  try {
    // ---- 設定がないとき: 今までどおり合言葉だけ
    let app = await createApp({ root, vars: { ...base } });
    let r = await send(app, sessionPath);
    check('Google の設定がなければ google:false（Google ボタンは出ない）', r.json && r.json.google === false, r.json);
    r = await send(app, '/auth/google');
    check('設定がなければ /auth/google は Google へ行かずトップへ戻す', r.status === 302 && r.headers.get('location') === 'https://test.local/', r.headers.get('location'));
    r = await send(app, protectedPath);
    check('設定がなければ 401 の応答も google:false', r.status === 401 && (!r.json || !r.json.google), r.json);
    app = await createApp({ root, vars: { ...base, ...G, OWNER_EMAIL: '' } });
    r = await send(app, sessionPath);
    check('3つのうち1つでも欠けていれば google:false', r.json && r.json.google === false, r.json);

    // ---- 設定があるとき
    app = await createApp({ root, vars: { ...base, ...G } });
    r = await send(app, sessionPath);
    check('設定がそろえば google:true', r.json && r.json.google === true, r.json);
    r = await send(app, protectedPath);
    check('未ログインの 401 にも google:true（入口で Google ボタンを出す）', r.status === 401 && r.json && r.json.google === true, r.json);

    r = await send(app, '/auth/google');
    const loc = new URL(r.headers.get('location') || 'https://x/');
    const stateC = r.cookies.find((c) => c.startsWith('__Host-g_state='));
    const state = stateC ? stateC.split(';')[0].split('=')[1] : '';
    check('/auth/google は Google のアカウント選択へ送る', r.status === 302 && loc.origin + loc.pathname === 'https://accounts.google.com/o/oauth2/v2/auth', loc.href);
    check('送り先の中身（client_id・戻り先・openid email・アカウント選択・state）',
      loc.searchParams.get('client_id') === G.GOOGLE_CLIENT_ID
      && loc.searchParams.get('redirect_uri') === 'https://test.local/auth/google/callback'
      && loc.searchParams.get('response_type') === 'code'
      && loc.searchParams.get('scope') === 'openid email'
      && loc.searchParams.get('prompt') === 'select_account'
      && state.length >= 20 && loc.searchParams.get('state') === state, loc.search);
    check('state は短命の Cookie（HttpOnly・Secure・Lax・10分）', !!stateC && /HttpOnly/.test(stateC) && /Secure/.test(stateC) && /SameSite=Lax/.test(stateC) && /Max-Age=600/.test(stateC), stateC);
    check('client_secret は送り先 URL に出さない', !loc.href.includes(G.GOOGLE_CLIENT_SECRET));
    const stateCookie = `__Host-g_state=${state}`;

    mockGoogle(() => ({ body: { id_token: idToken({ email: 'owner@example.com' }), access_token: 'x' } }));
    r = await send(app, `/auth/google/callback?code=abc&state=${state}x`, { cookie: stateCookie });
    check('state が違えば 400（Google には問い合わせない）', r.status === 400 && tokenCalls.length === 0 && !cookieOf(r.cookies, cookieName), r.status);
    r = await send(app, `/auth/google/callback?code=abc&state=${state}`);
    check('state の Cookie がなければ 400', r.status === 400 && tokenCalls.length === 0, r.status);
    r = await send(app, '/auth/google/callback?error=access_denied&state=' + state, { cookie: stateCookie });
    check('Google 側で取りやめたら日本語の案内（Cookie は出さない）', r.status === 400 && r.text.includes('取りやめました') && !cookieOf(r.cookies, cookieName), r.status);

    mockGoogle(() => ({ body: { id_token: idToken({ email: 'stranger@example.com' }) } }));
    r = await send(app, `/auth/google/callback?code=abc&state=${state}`, { cookie: stateCookie });
    check('持ち主以外のメールは 403「このGoogleアカウントでは入れません」', r.status === 403 && r.text.includes('このGoogleアカウントでは入れません') && r.text.includes('別のアカウントで試す'), r.status);
    check('403 のときセッション Cookie は出さない', !cookieOf(r.cookies, cookieName), r.cookies);
    const p = tokenCalls[0];
    check('code の交換に client_secret・戻り先・code を送る', p && p.get('client_secret') === G.GOOGLE_CLIENT_SECRET && p.get('code') === 'abc'
      && p.get('redirect_uri') === 'https://test.local/auth/google/callback' && p.get('grant_type') === 'authorization_code', p && Object.fromEntries(p));

    for (const [claims, why] of [
      [{ email: 'owner@example.com', aud: 'someone-else' }, 'aud が別のアプリ'],
      [{ email: 'owner@example.com', iss: 'https://evil.example.com' }, 'iss が Google でない'],
      [{ email: 'owner@example.com', email_verified: false }, 'メール未確認'],
      [{ email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) - 10 }, '期限切れ'],
    ]) {
      mockGoogle(() => ({ body: { id_token: idToken(claims) } }));
      r = await send(app, `/auth/google/callback?code=abc&state=${state}`, { cookie: stateCookie });
      check(`id_token の確認で断る（${why}）`, r.status === 400 && !cookieOf(r.cookies, cookieName), r.status);
    }
    mockGoogle(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    r = await send(app, `/auth/google/callback?code=abc&state=${state}`, { cookie: stateCookie });
    check('code の交換に失敗したら 502（Cookie は出さない）', r.status === 502 && !cookieOf(r.cookies, cookieName), r.status);

    // ---- 正しいメール（大文字小文字は無視）
    mockGoogle(() => ({ body: { id_token: idToken({ email: 'OWNER@example.com' }) } }));
    r = await send(app, `/auth/google/callback?code=abc&state=${state}`, { cookie: stateCookie });
    const gCookie = cookieOf(r.cookies, cookieName);
    const gFull = r.cookies.find((c) => c.startsWith(cookieName + '=')) || '';
    check('持ち主のメールならセッション Cookie を出してトップへ', r.status === 302 && r.headers.get('location') === 'https://test.local/' && !!gCookie && gCookie.length > cookieName.length + 10, r.status);
    check('Cookie は合言葉と同じ 400日・HttpOnly・Secure', /Max-Age=34560000/.test(gFull) && /HttpOnly/.test(gFull) && /Secure/.test(gFull), gFull);
    check('使い終わった state の Cookie は消す', r.cookies.some((c) => c.startsWith('__Host-g_state=;') && /Max-Age=0/.test(c)), r.cookies);
    r = await send(app, protectedPath, { cookie: gCookie });
    check('Google で入った Cookie で API が通る', r.status === 200, r.status);
    r = await send(app, sessionPath, { cookie: gCookie });
    check('session も authed:true', r.json && r.json.authed === true, r.json);

    mockGoogle(() => ({ body: { id_token: idToken({ email: 'second@example.com' }) } }));
    r = await send(app, `/auth/google/callback?code=abc&state=${state}`, { cookie: stateCookie });
    check('OWNER_EMAIL のカンマ区切りの2人目も入れる', r.status === 302 && !!cookieOf(r.cookies, cookieName), r.status);

    // 合言葉ログインと同じ Cookie（＝既存のログイン状態が壊れない・合言葉を変えれば両方切れる）
    r = await send(app, '/api/login', { method: 'POST', body: loginBody(APP_KEY) });
    check('合言葉でも今までどおり入れて、Google と同じ Cookie になる', r.status === 200 && cookieOf(r.cookies, cookieName) === gCookie, r.status);
    app.env.APP_KEY = 'changed-key';
    r = await send(app, protectedPath, { cookie: gCookie });
    check('合言葉を変えると Google で入った Cookie も無効になる', r.status === 401, r.status);
  } finally {
    globalThis.fetch = realFetch;
  }
}
