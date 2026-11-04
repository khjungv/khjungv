const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Read local-only secrets without adding a dependency. The file is git-ignored.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { if (error.code !== 'ENOENT') console.error('로컬 설정 파일을 읽지 못했습니다.'); }

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
const INDEX_FILE = path.join(DATA_DIR, 'recordings.json');
const MAX_BYTES = 500 * 1024 * 1024;
const GROQ_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_SUMMARY_MODEL = 'openai/gpt-oss-20b';

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('기록 목록을 읽지 못했습니다:', error.message);
    return [];
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function safeTitle(value) {
  return String(value || '').trim().replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
}

async function saveIndex(items, id) {
  const tempIndex = `${INDEX_FILE}.${id}.tmp`;
  await fs.promises.writeFile(tempIndex, JSON.stringify(items, null, 2), 'utf8');
  await fs.promises.rename(tempIndex, INDEX_FILE);
}

function findRecord(id) {
  if (!/^[\w-]{1,80}$/.test(id)) return null;
  return readIndex().find(item => item.id === id) || null;
}

async function writeRequestToFile(req, target, maxBytes) {
  const output = fs.createWriteStream(target, { flags: 'wx' });
  let bytes = 0;
  let tooLarge = false;
  let streamError;
  output.on('error', error => { streamError = error; });
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) { tooLarge = true; continue; }
      if (!output.write(chunk)) await new Promise((resolve, reject) => {
        output.once('drain', resolve);
        output.once('error', reject);
      });
      if (streamError) throw streamError;
    }
    if (tooLarge) {
      output.destroy();
      await fs.promises.unlink(target).catch(() => {});
      return { bytes, tooLarge: true };
    }
    if (streamError) throw streamError;
    const completed = new Promise((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
    });
    output.end();
    await completed;
    return { bytes, tooLarge: false };
  } catch (error) {
    output.destroy();
    await fs.promises.unlink(target).catch(() => {});
    throw error;
  }
}

async function readGroqError(response) {
  let details = '';
  try { details = (await response.json()).error?.message || ''; } catch {}
  if (response.status === 429) return 'Groq 무료 API 한도에 도달했거나 요청이 몰렸습니다. 잠시 후 다시 시도해주세요.';
  if (response.status === 401 || response.status === 403) return 'Groq API 키가 유효하지 않거나 이 모델을 사용할 수 없습니다. 서버의 .env.local 설정을 확인해주세요.';
  return details ? `Groq 요청 실패 (${response.status}): ${details}` : `Groq 요청에 실패했습니다 (${response.status}).`;
}

async function generateReport(record) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Groq API 키가 설정되지 않았습니다. 서버 폴더의 .env.local 파일을 확인한 뒤 서버를 다시 시작해주세요.'), { status: 503 });
  if (record.size > GROQ_MAX_AUDIO_BYTES) throw Object.assign(new Error('Groq 무료 전사 API는 파일당 25MB까지 지원합니다. 이 녹음은 로컬에 보존되어 있습니다. 더 짧게 녹음하거나 파일 크기를 줄인 뒤 다시 시도해주세요.'), { status: 413 });

  const audio = await fs.promises.readFile(path.join(RECORDINGS_DIR, record.filename));
  const form = new FormData();
  form.append('file', new Blob([audio], { type: record.mimeType || 'audio/webm' }), record.filename);
  form.append('model', GROQ_STT_MODEL);
  form.append('language', 'ko');
  form.append('response_format', 'verbose_json');

  const sttResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(180000)
  });
  if (!sttResponse.ok) throw Object.assign(new Error(await readGroqError(sttResponse)), { status: sttResponse.status === 429 ? 429 : 502 });
  const transcription = await sttResponse.json();
  const transcript = String(transcription.text || '').trim();
  if (!transcript) throw Object.assign(new Error('전사 결과가 비어 있습니다. 녹음 상태를 확인해주세요.'), { status: 422 });

  const askGroq = async (content, maxTokens) => {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_SUMMARY_MODEL, messages: [
        { role: 'system', content: '당신은 면담 기록 작성 보조 도구입니다. 제공된 내용에 없는 사실이나 임상적 진단을 만들지 말고, 불확실성은 분명히 표시하십시오.' },
        { role: 'user', content }
      ], temperature: 0.1, max_completion_tokens: maxTokens }), signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) throw Object.assign(new Error(await readGroqError(response)), { status: response.status === 429 ? 429 : 502 });
    const payload = await response.json();
    return String(payload.choices?.[0]?.message?.content || '').trim();
  };

  let reportSource = transcript;
  if (transcript.length > 3500) {
    const chunks = [];
    for (let start = 0; start < transcript.length; start += 3500) chunks.push(transcript.slice(start, start + 3500));
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      const note = await askGroq(`아래 면담 전사 구간 ${i + 1}/${chunks.length}의 핵심 내용만 5개 이내 글머리표로 요약하라. 진술과 사실을 구분하고, 불확실한 내용은 [확인 필요]로 표시하라. 빠진 사실을 추정하지 말라.\n\n${chunks[i]}`, 700);
      notes.push(note);
    }
    reportSource = `전사문을 ${chunks.length}개 구간으로 나누어 정리한 핵심 메모:\n${notes.join('\n\n')}`;
  }
  const prompt = `다음은 군종장교와 장병의 면담 전사 내용 또는 구간별 핵심 메모다. 한국어 상담보고서 초안을 작성하라.\n\n원칙:\n- 제공된 내용에 근거한 사실만 기록하고 추측, 진단, 사실의 보충을 하지 않는다.\n- 장병의 진술과 확인된 사실을 구분한다. 불명확하거나 전사 오류가 의심되는 내용은 [확인 필요]라고 표시한다.\n- 해당 내용이 없으면 '언급 없음'으로 적고 항목을 임의로 채우지 않는다.\n- 민감한 개인 정보를 반복하거나 불필요하게 노출하지 않는다.\n- 종교적·정서적 지원 필요나 위험을 임의로 판정하지 않는다.\n- 아래 제목을 유지하고 간결한 보고서 초안으로 작성한다.\n\n보고서 제목: 상담 면담 보고서 (AI 초안)\n1. 면담 개요 (제목: ${record.title}; 날짜: ${record.date})\n2. 면담 주제\n3. 장병 주요 진술 및 호소\n4. 확인된 사실과 미확인 내용\n5. 지원 및 조치 사항\n6. 후속 확인 계획\n7. 작성자 검토 사항\n\n면담 내용:\n${reportSource}`;
  const report = await askGroq(prompt, 1800);
  if (!report) throw Object.assign(new Error('보고서 결과가 비어 있습니다.'), { status: 502 });
  return { transcript, report, generatedAt: new Date().toISOString(), transcriptionModel: GROQ_STT_MODEL, summaryModel: GROQ_SUMMARY_MODEL };
}

function serveStatic(req, res, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return send(res, 400, { error: '잘못된 경로입니다.' }); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: '접근할 수 없는 경로입니다.' });
  fs.readFile(target, (error, data) => {
    if (error) return send(res, error.code === 'ENOENT' ? 404 : 500, '파일을 찾을 수 없습니다.', 'text/plain; charset=utf-8');
    const ext = path.extname(target).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/recordings') {
    return send(res, 200, readIndex().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { groqConfigured: Boolean(process.env.GROQ_API_KEY) });
  }

  const reportRoute = url.pathname.match(/^\/api\/recordings\/([\w-]+)\/report$/);
  if (req.method === 'POST' && reportRoute) {
    const record = findRecord(reportRoute[1]);
    if (!record) return send(res, 404, { error: '면담 녹음을 찾을 수 없습니다.' });
    generateReport(record).then(async result => {
      const items = readIndex();
      const index = items.findIndex(item => item.id === record.id);
      if (index < 0) throw new Error('저장된 녹음 기록이 사라졌습니다.');
      items[index] = { ...items[index], ...result };
      const reportsDir = path.join(DATA_DIR, 'reports');
      await fs.promises.mkdir(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `${record.id}.md`);
      const tempReportPath = `${reportPath}.tmp`;
      await fs.promises.writeFile(tempReportPath, result.report, 'utf8');
      await fs.promises.rename(tempReportPath, reportPath);
      await saveIndex(items, record.id);
      send(res, 200, { transcript: result.transcript, report: result.report, generatedAt: result.generatedAt });
    }).catch(error => {
      const status = Number.isInteger(error.status) ? error.status : 502;
      send(res, status, { error: error.message || '전사 또는 보고서 생성에 실패했습니다. 녹음 파일은 그대로 보존됩니다.' });
    });
    return;
  }

  if (req.method === 'PUT' && reportRoute) {
    const record = findRecord(reportRoute[1]);
    if (!record) return send(res, 404, { error: '면담 녹음을 찾을 수 없습니다.' });
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString('utf8');
      if (body.length > 1_000_000) { send(res, 413, { error: '수정 내용이 너무 큽니다.' }); req.destroy(); }
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const update = JSON.parse(body);
        if (typeof update.transcript !== 'string' || typeof update.report !== 'string') return send(res, 400, { error: '전사문과 보고서 내용을 확인해주세요.' });
        const items = readIndex();
        const index = items.findIndex(item => item.id === record.id);
        items[index] = { ...items[index], transcript: update.transcript, report: update.report, editedAt: new Date().toISOString() };
        const reportsDir = path.join(DATA_DIR, 'reports');
        await fs.promises.mkdir(reportsDir, { recursive: true });
        await fs.promises.writeFile(path.join(reportsDir, `${record.id}.md`), update.report, 'utf8');
        await saveIndex(items, record.id);
        send(res, 200, { saved: true });
      } catch {
        send(res, 400, { error: '수정 내용을 저장하지 못했습니다.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/recordings') {
    const title = safeTitle(url.searchParams.get('title'));
    const date = String(url.searchParams.get('date') || '').slice(0, 10);
    const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const filename = `${id}.${ext}`;
    const target = path.join(RECORDINGS_DIR, filename);
    (async () => {
      const saved = await writeRequestToFile(req, target, MAX_BYTES);
      const bytes = saved.bytes;
      if (saved.tooLarge) return send(res, 413, { error: '녹음 파일이 너무 큽니다. 최대 500MB까지 저장할 수 있습니다.' });
      if (!bytes) return fs.promises.unlink(target).catch(() => {}).then(() => send(res, 400, { error: '저장할 녹음 데이터가 없습니다.' }));
      const record = { id, title: title || '제목 없는 면담', date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10), filename, mimeType, size: bytes, createdAt: new Date().toISOString() };
      const items = readIndex();
      items.push(record);
      const tempIndex = `${INDEX_FILE}.${id}.tmp`;
      fs.promises.writeFile(tempIndex, JSON.stringify(items, null, 2), 'utf8')
        .then(() => fs.promises.rename(tempIndex, INDEX_FILE))
        .then(() => send(res, 201, record))
        .catch(async () => {
          await Promise.all([fs.promises.unlink(target).catch(() => {}), fs.promises.unlink(tempIndex).catch(() => {})]);
          send(res, 500, { error: '녹음 기록을 저장하지 못했습니다. 디스크 공간과 쓰기 권한을 확인해주세요.' });
        });
    })().catch(async error => {
      await fs.promises.unlink(target).catch(() => {});
      if (res.writableEnded) return;
      send(res, 500, { error: '녹음 파일을 저장하지 못했습니다. 디스크 공간과 쓰기 권한을 확인해주세요.' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/recordings/')) {
    const name = path.basename(url.pathname.slice('/recordings/'.length));
    if (!/^[\w.-]+\.(webm|mp4|ogg|wav)$/.test(name)) return send(res, 400, { error: '잘못된 파일명입니다.' });
    const record = readIndex().find(item => item.filename === name);
    if (!record) return send(res, 404, { error: '녹음 파일을 찾을 수 없습니다.' });
    res.writeHead(200, { 'Content-Type': record.mimeType, 'Content-Length': record.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(RECORDINGS_DIR, name)).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  send(res, 405, { error: '지원하지 않는 요청입니다.' });
});

server.listen(PORT, HOST, () => {
  console.log(`면담 녹음 서비스가 http://${HOST}:${PORT} 에서 실행 중입니다.`);
  console.log(`녹음 파일 저장 위치: ${RECORDINGS_DIR}`);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`포트 ${PORT}를 이미 사용 중입니다. PORT 환경 변수를 바꿔 실행하세요.`);
  else console.error(error);
  process.exitCode = 1;
});
