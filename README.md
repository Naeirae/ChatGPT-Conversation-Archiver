# ChatGPT Conversation Archiver

[![Verify](https://github.com/Naeirae/ChatGPT-Conversation-Archiver/actions/workflows/verify.yml/badge.svg)](https://github.com/Naeirae/ChatGPT-Conversation-Archiver/actions/workflows/verify.yml)

Chrome extension for archiving complete ChatGPT conversations — including rich text formatting and images where possible — and exporting them to Google Docs.

> Work in progress. No license has been selected yet.

Project docs: [Architecture](ARCHITECTURE.md) · [Development and verification](DEVELOPMENT.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)

## Goal

Save a ChatGPT conversation as an editable document rather than a screenshot:

- capture complete user messages and ChatGPT replies;
- expand truncated messages before capture;
- preserve semantic formatting: headings, bold, italics, lists, links, code blocks and tables;
- keep image positions and try to carry images into Google Docs;
- collect the conversation locally first, then export it to Google Docs in one separate step.

The project does **not** use the ChatGPT API and is not part of another extension family. It is a standalone browser extension.


## Как работает сбор

По умолчанию сбор идет в **фоновом режиме**: расширение дублирует уже открытый диалог в рабочую копию, кратко активирует ее для hydration и затем возвращает фокус в исходный чат. Если ChatGPT не может загрузить рабочую копию, popup предлагает повторить тот же запуск в **обычном режиме** — прямо в текущей вкладке. В обычном режиме физическая прокрутка видна, а текущий чат лучше не трогать до завершения.

Маршрут полного сбора:

1. выбирается источник сбора: рабочая копия (по умолчанию) или текущая вкладка; рабочая копия сначала проходит hydration-проверку, а при явной ошибке загрузки расширение до трех раз нажимает «Попробовать снова»;
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



### Защита от дублей

Полный режим **«Собрать заново»** обновляет только локальный архив и никогда автоматически не дописывает весь пересобранный архив в ранее связанный Google Doc.

Автоматическая запись в связанный Google Doc разрешена только для проверенной дельты из **«Продолжить»** или **«Сверить»**.

Ручная команда вставки в уже связанный Google Doc также работает fail-closed: если сохраненный message-id после пересбора изменился, расширение пытается подтвердить стык по хвосту из нескольких сигнатур. Если точка продолжения не подтверждена, полный архив повторно не вставляется — пользователь получает предложение запустить **«Сверить»**.

## Режимы вкладки сбора

**Фоновый режим — рабочая копия** используется по умолчанию. Расширение открывает отдельную вкладку того же ChatGPT-диалога активной, дожидается появления message DOM, запускает collector и возвращает фокус в исходный чат. Дальше физическая wheel-прокрутка идет в рабочей вкладке, а исходный чат остается свободным. Это восстановленный capture-path версии 0.3.10 — последней версии, для которой в live-тесте был подтвержден полный сбор длинного чата (32 сообщения).

**Обычный режим — текущая вкладка** не создает копию. Content script и физические wheel-события работают прямо в открытом чате. Исходная вкладка никогда не закрывается при cancel/error/complete; этот режим остается резервным fallback, если рабочая копия не загружается.

Кнопка автоматического fallback не меняет постоянную настройку: следующий новый запуск снова остается фоновым по умолчанию, если пользователь сам не выбрал обычный режим в селекторе.

## Current MVP

The first prototype does the following:

1. Uses a duplicated working copy by default, with an explicit current-tab fallback mode.
2. Physically scrolls the virtualized conversation with DevTools Protocol wheel events.
3. Captures individual message units as rich HTML + plain text and keeps stable message IDs where available.
4. Stores the captured conversation locally in `chrome.storage.local`.
5. Can continue an existing local archive by collecting only messages after the saved anchor.
6. Can import a Google Doc as a continuation baseline, including Docs split into multiple document tabs, and verifies the tail against the live ChatGPT conversation before promoting it.
7. Builds a rich clipboard fragment with `Пользователь` / `ChatGPT` separators.
8. Opens `docs.new` or uses an existing Google Doc and performs a physical paste.
9. For a linked Google Doc, continuation appends only the captured delta instead of the full archive.
10. Can export a completed archive into multiple Google Docs document tabs with manual message-number boundaries and H2 topic subheadings.



## Разбивка архива по вкладкам Google Docs

После полного сбора архив можно сохранить в новый Google Doc не одним полотном, а по **document tabs**.

Popup открывает отдельную **визуальную страницу разметки архива**. На ней можно прокручивать реплики в хронологическом порядке и ставить пометки прямо у нужного сообщения:

- **«Вкладка перед»** — начать новую Google Docs tab перед этой репликой;
- **«Подзаголовок»** — вставить H2 перед этой репликой и сразу ввести название темы;
- первая вкладка существует автоматически, поэтому у сообщения №1 граница новой вкладки недоступна;
- пометки сохраняются локально отдельно для конкретного архива и не теряются при закрытии страницы разметки;
- длинные сообщения показываются свернутыми и могут быть раскрыты на месте; доступные изображения показываются миниатюрами, чтобы тематическую границу можно было выбирать визуально;
- названия самих вкладок в этой версии не автоматизируются: их можно переименовать вручную в Google Docs;
- после завершения много-вкладочного экспорта связь с чатом сохраняется на **последнюю созданную вкладку**, поэтому обычное `Продолжить` дописывает хвост туда же;
- если создание очередной вкладки через интерфейс Google Docs не удалось, экспорт останавливается и оставляет уже созданный документ открытым, не притворяясь завершенным.

Внутри разметчика пометки по-прежнему сериализуются в детерминированный message-number plan перед экспортом, но пользователю не нужно редактировать или копировать этот технический формат вручную.

## Сверка, продолжение и Google Docs

**Сверить с архивом** и **Продолжить** — разные действия.

**Сверить с архивом** использует локальный архив текущего чата как точку сравнения. Расширение находит последний подтверждённый стык, проходит до текущего конца разговора и показывает количество новых сообщений. Эта операция не меняет локальный архив и ничего не записывает в Google Docs.

**Продолжить** использует тот же локальный стык, но уже сохраняет найденную дельту в локальный архив. Поле Google Doc при этом необязательно:

- если поле пустое и для чата есть связанный Google Doc, дельта добавляется туда;
- если поле пустое и связанного документа нет, обновляется только локальный архив;
- если в поле вставить другую ссылку, дельта добавляется в этот Google Doc только для текущего запуска;
- одноразовый документ не заменяет и впоследствии не восстанавливается как каноническая связанная ссылка чата.

Старый путь чтения Google Doc как исходной точки не удалён. Он находится под **Восстановить точку продолжения из Google Doc** и предназначен для случая, когда локального архива нет или его стыку нельзя доверять. Расширение:

1. читает документ через интерфейс Google Docs;
2. проходит его document tabs;
3. распознаёт блоки `Пользователь:` / `ChatGPT:`;
4. ищет несколько последних непустых реплик в текущем ChatGPT;
5. только после подтверждённого стыка создаёт рабочую локальную точку и добирает хвост.

Одной короткой реплики недостаточно для внешнего восстановления: matcher предпочитает 2–4 соседних непустых сообщения. Неподтверждённый Google Doc не заменяет локальный архив.

### Images

Image discovery is message-level rather than text-root-only: the collector also inspects attachment images rendered as siblings inside the same virtualized turn wrapper. Tiny avatars/icons are filtered out.

From 0.3.14 the archive stores more than the source URL. During finalization the collector tries to fetch every detected image while the ChatGPT page/session is still available, converts it to a clipboard-friendly image blob (normally PNG), and stores a data URL plus MIME type/size/status in the local archive.

Google Docs export no longer asks Docs to fetch private ChatGPT image URLs from rich HTML. Text is pasted as rich HTML with image tags removed. When an archived message contains a prepared binary image, the debugger keeps the Docs tab active, writes the real image to the clipboard (ClipboardItem first, selected-image execCommand fallback), and performs a physical Ctrl+V at that point in the message sequence.

The popup reports separately how many images were detected, how many were prepared as binary data, and how many were actually inserted into Google Docs. Old archives created before 0.3.14 do not contain binary image data; run **Собрать заново** to repair their images.

## Engineering status

The repository is pre-1.0 and optimized for explicit failure handling rather than silent success claims.

Current quality gates:

- dependency-free JavaScript/manifest verification;
- GitHub Actions verification on pushes and pull requests;
- Windows PowerShell parser check for the updater;
- documented architecture, permission boundary and manual smoke matrix;
- duplicate-safe continuation that fails closed when a Google Docs splice cannot be verified.

The largest remaining engineering debt is modularization plus regression tests around capture/continuation behavior. See [ARCHITECTURE.md](ARCHITECTURE.md).

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

Для распакованной ZIP-копии не нужно каждый раз скачивать весь репозиторий.

Начиная с 0.3.28 кнопка **«Обновить»** в popup открывает отдельную страницу обновления внутри Chrome. Она показывает текущую и удалённую версии, прогресс, живой лог и работает через явный выбор папки распакованного расширения.

При первом запуске выберите папку, которую Chrome загрузил через **Load unpacked**. Доступ к папке хранится только в профиле Chrome как File System Access handle. Локальные файлы хэшируются на месте и не отправляются на сервер. Перед перезаписью изменённых файлов создаётся резервная копия в `.archiver-update-backup/browser-...`.

`update.cmd` + `update.ps1` сохраняются как **рабочий внешний fallback**. Это важно для первой миграции на 0.3.28: старую 0.3.27 удобнее один раз обновить через `update.cmd`, затем Reload — и после этого пользоваться обновлением из интерфейса.

`Update ChatGPT Archiver.vbs` больше не запускает скрытый PowerShell: реальный live-тест показал `Permission denied` в Windows Script Host, а защитное ПО дополнительно блокировало этот путь. Файл оставлен только как информационная заглушка для старых локальных установок.

На первом запуске существующие файлы, которые будут заменены, сохраняются в `.archiver-update-backup/<дата-время>/`. После создания state-файла последующие запуски останавливаются, если локальный файл отличается и от сохраненного baseline, и от текущей версии в GitHub.

После успешного обновления нажмите **Reload** у расширения на `chrome://extensions`.

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
