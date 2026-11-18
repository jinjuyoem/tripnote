# 여행노트 (tripnote)

트리플 대신 쓰는 개인 여행 앱. 일정·지도·항공권·가계부·정산을 동행인과 함께 관리합니다.

- Vite + Vanilla JS, PWA (홈 화면에 추가하면 앱처럼 실행)
- Firebase Auth (Google 로그인) + Firestore (서울 리전)
- Google Maps JavaScript API + Places API (New)

## 로컬 실행

```bash
npm install
cp .env.example .env.local   # 값 채우기
npm run dev                  # http://localhost:5173
```

## 배포 (Vercel)

1. 이 저장소를 Vercel에 Import
2. Environment Variables에 `.env.example`의 키를 모두 입력
3. Deploy → `xxx.vercel.app` 주소 확인
4. 배포 주소를 아래에 등록
   - Google Cloud > 사용자 인증 정보 > `tripnote-web` 키 > 웹사이트 제한사항: `https://xxx.vercel.app/*`
   - Firebase > Authentication > 설정 > 승인된 도메인: `xxx.vercel.app`
   - Google Cloud > 사용자 인증 정보 > OAuth 클라이언트(Web client) > 승인된 리디렉션 URI: `https://xxx.vercel.app/__/auth/handler`

`vercel.json`은 로그인 경로(`/__/auth`)를 Firebase로 프록시해서 아이폰 홈 화면 앱에서도 로그인이 유지되게 합니다.

## 보안 규칙

`firestore.rules` — 여행 참여자만 읽기/쓰기, 초대 링크(코드)로만 참여 가능. Firebase 콘솔 > Firestore > 규칙에 게시되어 있습니다.
