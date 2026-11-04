# 면담 녹음·보고서 서비스

Vercel에서 호스팅하는 개인용 웹앱입니다. 녹음 원본과 기록은 브라우저 IndexedDB에 저장되고, 보고서 생성을 요청한 경우에만 음성이 Vercel 함수를 거쳐 Groq API로 전달됩니다. Vercel 서버에는 상담 기록을 영구 저장하지 않습니다.

## Vercel 배포

1. GitHub 저장소 `khjungv/khjungv`를 Vercel 프로젝트에 연결하고 프레임워크는 **Other**로 선택합니다.
2. 프로젝트 Settings → Environment Variables에 `GROQ_API_KEY`와 `APP_ACCESS_TOKEN`을 추가합니다. 전자는 Groq에서 발급한 API 키이고, 후자는 본인만 아는 긴 임의 암호입니다. 둘 다 GitHub에 저장하지 않습니다.
3. Deployments에서 배포합니다. `vercel.json`은 `public/`을 정적 웹 루트로, `api/report.js`를 서버리스 함수로 지정합니다.

로컬에서 Vercel 환경을 미리 보려면 Vercel CLI 로그인 후 `vercel dev`를 실행합니다. `node server.js`는 기존 로컬 파일 저장 버전이며 IndexedDB 버전과 API가 다릅니다.

## 저장·전송 범위

- 녹음 파일, 전사문, 보고서, 수정 내용은 해당 브라우저 프로필의 IndexedDB에 보관됩니다. 다른 브라우저·기기와 자동 동기화되지 않습니다.
- 브라우저 데이터/사이트 저장공간을 지우면 기록이 삭제될 수 있습니다. 중요한 자료는 별도로 보관하세요.
- 보고서를 만들 때 음성은 Vercel 서버리스 함수를 통해 Groq에 전송되고, 함수는 결과만 브라우저에 반환합니다. 앱은 Vercel에 녹음·보고서를 영구 저장하지 않습니다.
- Vercel 함수 요청 본문 한도(4.5MB)에 맞추어 앱에서 4MB 이하의 녹음만 AI 보고서 생성에 사용할 수 있습니다. 녹음 자체는 더 커도 브라우저에 저장됩니다.
- 보고서 생성 함수는 `APP_ACCESS_TOKEN` 접근 암호를 확인합니다. 웹 화면의 **보고서 생성 접근 암호**에 같은 값을 입력해야 합니다. 암호를 모르는 사용자는 Groq API를 호출할 수 없습니다.
- Groq API 키와 접근 암호는 Vercel 환경 변수에만 설정합니다. 클라이언트 코드와 GitHub 저장소에 넣지 않습니다.

AI가 만든 보고서는 초안이므로 담당자가 검토하고 수정해야 합니다.
