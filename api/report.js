const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const STT_MODEL = 'whisper-large-v3-turbo';
const SUMMARY_MODEL = 'openai/gpt-oss-20b';
const crypto = require('node:crypto');

function tokenMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function askGroq(messages, maxTokens) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SUMMARY_MODEL, messages, temperature: 0.1, max_completion_tokens: maxTokens }),
    signal: AbortSignal.timeout(120000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 429 ? 'Groq API 사용 한도에 도달했습니다. 잠시 후 다시 시도해주세요.' : payload.error?.message || `Groq 요청 실패 (${response.status})`);
  return String(payload.choices?.[0]?.message?.content || '').trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  if (!process.env.APP_ACCESS_TOKEN) return res.status(503).json({ error: 'Vercel 환경 변수 APP_ACCESS_TOKEN을 먼저 설정해주세요.' });
  if (!tokenMatches(req.headers['x-app-access-token'], process.env.APP_ACCESS_TOKEN)) return res.status(401).json({ error: '보고서 생성 접근 암호가 올바르지 않습니다.' });
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Vercel 프로젝트 환경 변수 GROQ_API_KEY를 설정해주세요.' });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) return res.status(413).json({ error: 'Vercel 요청 한도에 맞춰 4MB 이하 녹음만 처리할 수 있습니다.' });
      chunks.push(chunk);
    }
    if (!size) return res.status(400).json({ error: '녹음 데이터가 비어 있습니다.' });
    const audio = Buffer.concat(chunks);
    const mimeType = String(req.query.mimeType || req.headers['content-type'] || 'audio/webm').split(';')[0];
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), `interview.${ext}`);
    form.append('model', STT_MODEL);
    form.append('language', 'ko');
    form.append('response_format', 'verbose_json');
    const stt = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form,
      signal: AbortSignal.timeout(180000)
    });
    const sttPayload = await stt.json().catch(() => ({}));
    if (!stt.ok) throw new Error(stt.status === 429 ? 'Groq API 사용 한도에 도달했습니다. 잠시 후 다시 시도해주세요.' : sttPayload.error?.message || `Groq 전사 요청 실패 (${stt.status})`);
    const transcript = String(sttPayload.text || '').trim();
    if (!transcript) throw new Error('전사 결과가 비어 있습니다. 녹음 상태를 확인해주세요.');
    const title = String(req.query.title || '제목 없는 면담').slice(0, 80);
    const date = String(req.query.date || '').slice(0, 10);
    const report = await askGroq([
      { role: 'system', content: '당신은 면담 기록 작성 보조 도구입니다. 제공된 내용에 없는 사실이나 임상적 진단을 만들지 말고, 불확실성은 분명히 표시하십시오.' },
      { role: 'user', content: `다음 면담 전사 내용을 바탕으로 한국어 상담보고서 초안을 작성하라. 사실을 추정하거나 보충하지 말고 불확실한 내용은 [확인 필요]라고 표시한다. 언급되지 않은 항목은 '언급 없음'으로 적고 민감정보를 불필요하게 반복하지 않는다.\n\n보고서 제목: 상담 면담 보고서 (AI 초안)\n1. 면담 개요 (제목: ${title}; 날짜: ${date})\n2. 면담 주제\n3. 장병 주요 진술 및 호소\n4. 확인된 사실과 미확인 내용\n5. 지원 및 조치 사항\n6. 후속 확인 계획\n7. 작성자 검토 사항\n\n전사문:\n${transcript}` }
    ], 1800);
    if (!report) throw new Error('보고서 결과가 비어 있습니다.');
    return res.status(200).json({ transcript, report, generatedAt: new Date().toISOString(), transcriptionModel: STT_MODEL, summaryModel: SUMMARY_MODEL });
  } catch (error) {
    return res.status(502).json({ error: error.message || '전사 또는 보고서 생성에 실패했습니다.' });
  }
};

module.exports.config = { api: { bodyParser: false }, maxDuration: 300 };
