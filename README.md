# ChatGPT Conversation Archiver

Chrome extension for archiving complete ChatGPT conversations — including rich text formatting and images where possible — and exporting them to Google Docs.

> Work in progress. No license has been selected yet.

## Goal

Save a ChatGPT conversation as an editable document rather than a screenshot:

- capture complete user messages and ChatGPT replies;
- expand truncated messages before capture;
- preserve semantic formatting: headings, bold, italics, lists, links, code blocks and tables;
- keep image positions and try to carry images into Google Docs;
- collect the conversation locally first, then export it to Google Docs in one separate step.

The project does **not** use the ChatGPT API and is not part of another extension family. It is a standalone browser extension.


## Как работает сбор

Сбор запускается как отдельная фоновая задача для открытой вкладки ChatGPT. После запуска окно расширения можно закрыть и переключиться на другую вкладку.

Маршрут сбора:

1. расширение находит контейнер переписки;
2. физически отматывает его в самое начало;
3. после каждого захода в начало ждет, пока страница догрузит старые сообщения;
4. когда начало стабилизировалось, проходит переписку вниз;
5. по пути раскрывает сокращенные сообщения и сохраняет уже увиденные сообщения до того, как виртуализированный интерфейс уберет их из DOM;
6. готовый архив сохраняется локально в профиле расширения;
7. только после завершения сбора архив можно отдельно вставить в Google Docs.

Если вкладка временно замораживается браузером, расширение показывает состояние паузы; если вкладку закрыть или увести с ChatGPT, текущий сбор завершается с ошибкой.

## Current MVP

The first prototype does the following:

1. Opens the current ChatGPT conversation.
2. Scrolls from the beginning to the end and tries to click local `Show more` / `Развернуть` controls inside messages.
3. Captures each `[data-message-author-role]` turn as rich HTML + plain text.
4. Stores the captured conversation locally in extension IndexedDB.
5. Builds one rich clipboard fragment with `Пользователь` / `ChatGPT` separators.
6. Opens `docs.new` or uses an already-open Google Doc.
7. Focuses the Google Docs editor through Chrome DevTools Protocol and performs a physical paste.

### Images

Image URLs and their positions are captured. In `0.1.0`, Google Docs receives them through the rich HTML clipboard, so image insertion is **best effort**. Authenticated/blob images may not survive the paste yet. A dedicated image-blob pipeline is planned after the basic text/formatting round-trip is proven.

## Install locally

1. Download or clone the repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.

## First test

1. Open a ChatGPT conversation.
2. Click the extension icon.
3. Click **Собрать текущий чат**.
4. Check the reported message/image count.
5. Click **Сохранить в новый Google Doc**.
6. Verify:
   - first and last messages are present;
   - long messages are complete;
   - user/assistant order is correct;
   - headings/lists/links/code/table formatting survived;
   - images either survived or are the only missing layer.

## Privacy

The MVP stores the captured conversation locally in the browser extension profile. It does not send conversation content to a project server.

## Known risks

- ChatGPT DOM selectors can change.
- Very long conversations may be virtualized/lazy-loaded differently and need additional traversal logic.
- Google Docs is not a normal contenteditable DOM; export intentionally uses physical UI interaction rather than a private Docs API.
- Rich clipboard image behavior differs by image URL/authentication method.

## License

No license selected yet.

## Быстрое обновление локальной копии

Для распакованной ZIP-копии не нужно каждый раз скачивать весь репозиторий. Запустите `update.cmd` из корня расширения.

`update.cmd` — стабильный bootstrap: он скачивает свежий `update.ps1` из публичной ветки `main` без токена GitHub и запускает его отдельно. Основной updater сравнивает Git blob SHA, скачивает только отсутствующие или изменившиеся файлы и хранит локальный baseline в `.chatgpt-archiver-updater-state.json`.

На первом запуске updater сверяет локальную версию с официальной историей репозитория, поэтому старый официальный ZIP можно отличить от вручную изменённого файла. Если обнаружена локальная правка, updater останавливается до записи файлов и выводит её имя вместо молчаливой перезаписи.

Последний запуск записывается в `updater-last.log`. Окно `update.cmd` остаётся открытым до нажатия клавиши и при успехе, и при ошибке.

После успешного обновления перезагрузите расширение на `chrome://extensions`.

## Настройки архива

- **Имя пользователя:** если поле пустое, маркировка остается `Пользователь:`; если заполнено — `Пользователь / Имя:`.
- **Имя ChatGPT:** необязательное имя для маркировки реплик ассистента.
- **Пользовательские реплики — по правому краю:** переносит пользовательский блок в правую часть документа; для ручного/резервного форматирования в Google Docs используется `Ctrl+Shift+R`.
- **Сохранять доступные размышления:** расширение раскрывает доступные пользователю блоки «Думаю»/«Размышляю» и сохраняет их, если они присутствуют в DOM. Скрытое внутреннее содержимое, недоступное интерфейсу, не извлекается.
- **Палитра:** Океан, Кобальт, Небо или Полночь.

Имена и настройки хранятся локально в `chrome.storage.local`.

## Безопасность

Для вставки в Google Docs используется `chrome.debugger`. Это разрешение само по себе вызывает предупреждение Chrome о доступе к отладчику страниц. В текущем контуре debugger используется для взаимодействия с редактором Google Docs; расширение не читает пароли или токены.

Сбор не отправляет сообщения в ChatGPT. Автоматически выполняются только прокрутка открытой переписки, раскрытие доступных элементов по включенной настройке и копирование уже отображаемого содержимого.

ChatGPT может применять защитные механизмы к необычной автоматизированной активности. Поэтому сбор работает с паузами и не выполняет генерацию или отправку сообщений.

## Сбор текущего диалога

Перед сбором расширение проверяет активную вкладку. Сначала отсеивается любой адрес вне ChatGPT; затем через Chrome Debugger читается фактический URL страницы. Для обычных чатов и чатов внутри GPT/проекта принимаются URL с сегментом `/c/<conversation-id>`. Если открыт ChatGPT, но не конкретный диалог, показывается отдельное сообщение: **«Убедитесь, что в активной вкладке открыт диалог ChatGPT.»**

После проверки сразу запускается фоновая прокрутка к началу страницы. Затем основной сборщик отдельно проходит весь загруженный диапазон и дожидается догрузки истории.

### Размышления

Названия блоков размышлений не зашиты в список переводов. При включенной настройке расширение ищет структурные раскрываемые блоки внутри реплик ассистента: учитывает `aria-expanded`, `aria-controls`, состояние раскрытия и положение блока относительно основного ответа. Если у блока есть собственный заголовок, он сохраняется как его название. Это позволяет не зависеть от конкретного текста вроде «Думаю» или «Thinking».

Конкретную DOM-структуру reasoning-блока нужно подтверждать на живой странице ChatGPT; если текущий rollout использует другую структуру, расширение должно расширять адаптер, а не угадывать содержимое по словам.
