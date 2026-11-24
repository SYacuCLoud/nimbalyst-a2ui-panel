# A2UI Panel

님블에서 A2UI v1.0 화면을 그려요.

- 파일: `.a2ui.json` 파일에 A2UI v1.0 메시지 배열(JSON 배열이나 한 줄에 하나씩 쓴 JSONL)을 쓰면, 파일을 열었을 때 오른쪽 칸에 그려져요. 파일을 고치면 처음부터 다시 그려요. 버튼을 누르면 그 동작과 데이터 모델이 대화 입력창 위에 칩으로 붙어요. 자동으로 보내지는 않아요.
- A2UI 칸: 일반 세션이 `a2ui-panel.show` 도구로 보낸 화면을 지금 보고 있는 세션 기준으로 보여 줘요. Ctrl+Alt+Shift+A 로 마지막 자리(왼쪽·오른쪽·아래)에 열고 닫고, 칸 머리글의 ◧ ⬓ ◨ 로 자리를 바꿔요. 자리, 열림 여부, 왼쪽·오른쪽 폭은 localStorage 에 기억하고, 님블을 다시 켜면 마지막에 열려 있던 자리에 다시 열어요. 아래 칸 높이는 님블이 관리해요(확장은 저장하지 않아요). ⓘ 는 진단 정보를 펼쳐요(오류가 있으면 저절로 보여요). 버튼을 누르면 동작과 데이터 모델이 그 세션에 새 메시지로 바로 들어가요.
- 칸은 Agent 모드에서만 보여요. 다른 모드로 가면 숨기고(열림·자리 저장값은 그대로), 돌아오면 같은 자리에 다시 보여요. Agent 모드는 `.chat-sidebar` 밖에 있는 `.agent-session-panel[data-session-id]` 가 화면에 보이는지로 판단해요.
- 왼쪽 자리는 Agent 모드의 세션 목록(`.session-history` 와, 왼쪽 끝과 폭이 같은 가장 바깥 조상)을 그 자리 그대로 덮어요. 못 찾으면 gutter 오른쪽에 붙고 본문을 밀어요.
- 활성 세션 ID 는 렌더러 DOM 에서 보이는 `.agent-session-panel[data-session-id]` 로 알아내요(파일 화면에서는 마지막에 본 세션을 써요).
- 님블은 placement "floating" 패널을 그리지 않아요. 그래서 왼쪽·오른쪽 칸은 확장이 `document.body` 에 직접 띄우고, 패널 토글 명령이 보내는 `nimbalyst:toggle-panel` 이벤트로 열고 닫아요.

## 빌드

`npm run build` 뒤 `manifest.json` 과 `dist/` 를 `%APPDATA%\@nimbalyst\electron\extensions\com.syacucloud.a2ui-panel\` 에 복사하고 님블을 다시 시작해요.
