# A2UI Panel

[Nimbalyst](https://nimbalyst.com) 확장이에요. 에이전트가 [A2UI](https://a2ui.org) v1.0 메시지로 보낸 화면을 세션 옆 칸에 그리고, 사용자가 누른 버튼을 그 세션에 새 메시지로 돌려보내요.

화면은 공식 렌더러 `@a2ui/react` 와 기본 카탈로그(`basicCatalog`)로만 그려요.

## 설치

```sh
npm install
npm run build
```

`manifest.json` 과 `dist/` 를 아래 폴더에 복사하고 Nimbalyst 를 다시 시작하세요.

```
%APPDATA%\@nimbalyst\electron\extensions\com.syacucloud.a2ui-panel\
```

## 쓰는 법

### 에이전트가 화면 보내기

세션에서 MCP 도구 `a2ui-panel_show` 를 부르세요. `messages` 에는 A2UI v1.0 메시지 배열을 넣어요.

```json
[
  { "version": "1.0", "createSurface": { "surfaceId": "s1", "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json" } },
  { "version": "1.0", "updateComponents": { "surfaceId": "s1", "components": [
    { "id": "root", "component": "Column", "children": ["t", "b"] },
    { "id": "t", "component": "Text", "text": { "@path": "/msg" } },
    { "id": "bt", "component": "Text", "text": "확인" },
    { "id": "b", "component": "Button", "child": "bt", "action": { "event": { "name": "ok" } } }
  ] } },
  { "version": "1.0", "updateDataModel": { "surfaceId": "s1", "path": "/", "value": { "msg": "안녕하세요" } } }
]
```

- 화면은 도구를 부른 세션에만 보여요. 지금 보고 있는 세션에 새 화면이 오면 칸이 저절로 열려요.
- 메시지가 잘못되면 도구 결과로 A2UI 오류 메시지가 돌아와요. 고쳐서 다시 보내면 돼요.
- 이미 있는 surface 에 `createSurface` 를 다시 보내면 `INTEGRITY_ERROR` 가 나요. 바꿀 때는 `updateComponents` 나 `updateDataModel` 을 보내세요.
- `Text` 의 `variant` 는 `caption` 과 `body` 만 돼요.

### 버튼 누르기

버튼을 누르면 아래 형식의 JSON 이 그 세션에 새 메시지로 바로 들어가고, 칸은 닫혀요. 에이전트가 답으로 화면을 다시 보내면 칸이 다시 열려요.

```json
{ "version": "1.0", "action": { "name": "ok", "surfaceId": "s1", "context": {} },
  "metadata": { "a2uiRendererDataModel": { "version": "1.0", "surfaces": { "s1": { "msg": "안녕하세요" } } } } }
```

에이전트가 답하기 전까지 같은 surface 의 버튼은 잠겨서 두 번 보내지지 않아요.

### 칸 열고 닫기

- `Ctrl+Alt+Shift+A` 나 왼쪽 gutter 버튼으로 열고 닫아요.
- 칸 머리글의 ◧ ⬓ ◨ 로 자리를 왼쪽, 아래, 오른쪽 가운데에서 골라요. 왼쪽은 세션 목록을 덮고, 오른쪽은 본문 폭을 줄여요.
- 자리, 열림 여부, 폭은 다시 시작해도 기억해요.
- 칸은 Agent 모드에서만 보여요. 다른 모드로 가면 숨었다가 돌아오면 다시 보여요.
- ⓘ 를 누르면 진단 정보가 펼쳐져요. 오류가 있으면 저절로 펼쳐져요.

### `.a2ui.json` 파일

`.a2ui.json` 파일에 메시지 배열(JSON 배열이나 한 줄에 하나씩 쓴 JSONL)을 쓰면, 파일을 열 때 화면이 그려져요. 이 편집기에서 버튼을 누르면 동작이 입력창에 칩으로 붙고, 자동으로 보내지는 않아요.

## 알아 둘 점

- 버튼 메시지는 Nimbalyst 의 내부 IPC(`ai:createQueuedPrompt`, `ai:triggerQueueProcessing`)로 보내요. 공개 API 가 아니라서 Nimbalyst 가 바뀌면 깨질 수 있어요.
- 왼쪽·오른쪽 칸은 Nimbalyst 가 그려 주지 않아서 확장이 직접 띄워요. 그래서 Nimbalyst 의 화면 구조(DOM)가 바뀌면 자리가 어긋날 수 있어요.
- 보낸 화면은 메모리에만 있어서, Nimbalyst 를 다시 시작하면 사라져요.
- 대화창 안에 위젯으로 그리는 기능은 [nimbalyst#2010](https://github.com/nimbalyst/nimbalyst/issues/2010) 에 요청해 두었어요.
