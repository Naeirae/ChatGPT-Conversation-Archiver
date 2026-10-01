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

Сбор запускается как отдельная задача в рабочей копии того же диалога. Из-за текущей виртуализации ChatGPT новая вкладка сначала кратко активируется, чтобы интерфейс гарантированно отрисовал message-unit узлы; после проверки DOM фокус возвращается в исходный чат, а рабочая вкладка продолжает сбор.

Маршрут полного сбора:

1. рабочая вкладка сначала проходит hydration-проверку: сбор не стартует, пока ChatGPT не отрисовал хотя бы один role/message shell;
2. расширение фиксирует конец снимка на момент запуска;
3. в рабочей вкладке отправляет реальные wheel-события через Chrome DevTools Protocol, чтобы виртуализированный список физически дошел до начала;
3. после каждой серии прокруток ждет стабилизации доступных message-unit узлов;
4. когда начало достигнуто, очищает временный навигационный буфер и физически проходит вниз;
5. по пути раскрывает доступные элементы и собирает сообщения в хронологическом порядке;
6. проход вниз останавливается на зафиксированном конце снимка, поэтому новые сообщения в исходной вкладке не растягивают задачу;
7. готовый архив сохраняется локально в `chrome.storage.local`.

Незавершенный проход не заменяет последний успешно сохраненный архив. В popup отдельно показываются:
- **последний запуск** как структурированный runtime-log: режим, этап, число собранных сообщений, итог и ошибка;
- **незавершенный черновик**, если ошибка произошла уже во время хронологического прохода вниз; такой черновик можно отдельно скопировать;
- **последний завершенный архив**, который можно скопировать напрямую в буфер обмена независимо от Google Docs;
- Google Docs остается отдельным export-каналом, а не единственным способом получить собранный текст.

Лог последнего запуска можно скопировать отдельной кнопкой. Runtime-log и архив — разные сущности: лог объясняет, что происходило, архив/черновик содержит сам текст.

Для уже сохраненного чата доступны три режима:

- **Собрать заново** — полный проход от начала до конца снимка.
- **Продолжить** — взять локальный последний подтвержденный anchor, добрать только сообщения после него и, если указан или уже связан Google Doc, дописать туда ту же дельту.
- **Сверить** — использовать фактический Google Doc как baseline. Расширение читает документ по вкладкам, берет хвост последних непустых реплик, ищет в ChatGPT надежный стык по нескольким соседним сообщениям и продолжает только после него.

Вкладки Google Docs считаются одной последовательностью архива: граница вкладки не является ошибкой. Если хвост короткий, сверка может использовать сообщения из предыдущей вкладки. После подтвержденного стыка дельта дописывается в ту вкладку, где находился хвост baseline.

Popup и badge показывают этапы 1/3 → 2/3 → 3/3, число собранных сообщений и текущий проход.

## Current MVP

The first prototype does the following:

1. Opens a dedicated background copy of the current ChatGPT conversation.
2. Physically scrolls the virtualized conversation with DevTools Protocol wheel events.
3. Captures individual message units as rich HTML + plain text and keeps stable message IDs where available.
4. Stores the captured conversation locally in `chrome.storage.local`.
5. Can continue an existing local archive by collecting only messages after the saved anchor.
6. Can import a Google Doc as a continuation baseline, including Docs split into multiple document tabs, and verifies the tail against the live ChatGPT conversation before promoting it.
7. Builds a rich clipboard fragment with `Пользователь` / `ChatGPT` separators.
8. Opens `docs.new` or uses an existing Google Doc and performs a physical paste.
9. For a linked Google Doc, continuation appends only the captured delta instead of the full archive.



## Продолжение и сверка с Google Docs

Поле **Google Doc архива** принимает ссылку вида `https://docs.google.com/document/d/...`.

**Продолжить** использует локальный архив как источник точки продолжения. Если в поле указан документ или для чата уже сохранена связь с Google Doc, после успешного capture туда автоматически отправляется только новая дельта.

**Сверить** предназначено для случая, когда сам Google Doc уже является архивом, а локальный state отсутствует или ему нельзя доверять. Расширение:

1. открывает копию документа;
2. физически копирует текст текущей вкладки через интерфейс Google Docs;
3. переходит по document tabs официальными сочетаниями Ctrl+Shift+PgUp/PgDown и собирает их в порядке документа;
4. распознает сохраненные блоки по маркерам `Пользователь:` / `ChatGPT:`;
5. игнорирует служебный дубль `ChatGPT сказал:` из старых экспортов;
6. берет несколько последних непустых реплик и ищет их последовательность в текущем ChatGPT;
7. только после найденного стыка превращает импортированный baseline в рабочий локальный архив и добавляет новые сообщения;
8. дописывает дельту в вкладку Google Doc, где находился подтвержденный хвост.

Одной короткой реплики недостаточно для внешней сверки: matcher предпочитает 2–4 соседних непустых сообщения. Неподтвержденный Google Doc не заменяет локальный архив.

### Images

Image discovery is message-level rather than text-root-only: the collector also inspects attachment images rendered as siblings inside the same virtualized turn wrapper. Tiny avatars/icons are filtered out. Image URLs and approximate positions are stored with the archive and included in the rich HTML export.

Google Docs still receives images through rich HTML paste, so insertion remains **best effort** for authenticated/blob URLs. If a detected image URL cannot survive clipboard paste, a dedicated image-blob pipeline is the next layer to add.

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
- Google Docs is not a normal contenteditable DOM; export intentionally uses physical UI interaction rather than a private Docs API. The rich clipboard fragment is prepared in the extension offscreen document with selection + `document.execCommand('copy')`, then Chrome Debugger focuses the Docs editor and sends the physical paste shortcut.
- Rich clipboard image behavior differs by image URL/authentication method.

## License

No license selected yet.

## Быстрое обновление локальной копии

Для распакованной ZIP-копии не нужно каждый раз скачивать весь репозиторий. Запустите `update.cmd` из корня расширения.

`update.cmd` и `update.ps1` — стабильная локальная пара управления обновлением и сами себя не заменяют. `update.cmd` только запускает лежащий рядом PowerShell-скрипт. `update.ps1` читает публичный GitHub без токена, сравнивает Git blob SHA, скачивает только отсутствующие или изменившиеся файлы и хранит baseline в `.chatgpt-archiver-updater-state.json`.

На первом запуске существующие файлы, которые будут заменены, сохраняются в `.archiver-update-backup/<дата-время>/`. После создания state-файла последующие запуски останавливаются, если локальный файл отличается и от сохраненного baseline, и от текущей версии в GitHub.

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

После проверки создается отдельная рабочая вкладка того же диалога. Она кратко активируется до появления реального DOM сообщений, затем фокус возвращается в исходный чат. Рабочая вкладка физически прокручивается wheel-событиями через Chrome Debugger; DOM используется для чтения уже подгруженных message-unit узлов, а не как источник виртуального `scrollTop`.

### Размышления

Названия блоков размышлений не зашиты в список переводов. При включенной настройке расширение ищет структурные раскрываемые блоки внутри реплик ассистента: учитывает `aria-expanded`, `aria-controls`, состояние раскрытия и положение блока относительно основного ответа. Если у блока есть собственный заголовок, он сохраняется как его название. Это позволяет не зависеть от конкретного текста вроде «Думаю» или «Thinking».

Конкретную DOM-структуру reasoning-блока нужно подтверждать на живой странице ChatGPT; если текущий rollout использует другую структуру, расширение должно расширять адаптер, а не угадывать содержимое по словам.
