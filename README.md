# HH Tracker (Cloudflare Worker + D1)

Telegram-бот для трекинга откликов из hh.ru.

## Что умеет сейчас

- **Мультипользовательский режим**: один Telegram user_id = одна “учётка” (данные не смешиваются).
- Копипаста из hh.ru → парсинг → сохранение в D1 (SQLite).
- **Статистика текстом** за период.
- **Отчёт с графиками** (картинки в Telegram).
- **CSV выгрузка** (файл прямо в чат).
- Опционально: **общая ссылка на Google Sheet** (одна для всех) через `SHEET_URL`.

Команды:
- `/new` — очистить буфер
- (вставляешь текст из hh.ru)
- `/done` — распарсить и сохранить
- `/stats [week|month|all]` — статистика
- `/report [week|month|all]` — статистика + графики
- `/export [week|month|all]` — CSV выгрузка
- `/sheet` — ссылка на общую таблицу (если `SHEET_URL` настроена)

> Период по умолчанию — `month`.

## 0. Что установить локально

- Node.js 18+ (лучше 20)
- Git

## 1. Создай репозиторий на GitHub

1) Создай новый repo (например `hh-tracker-worker`).
2) Скопируй содержимое этой папки в репозиторий.
3) Commit → push.

## 2. Создай D1 базу и привяжи в `wrangler.toml`

В корне проекта:

```bash
npm i
npx wrangler login
npx wrangler d1 create hh-tracker-db
```

Команда вернёт `database_id`. Вставь его в `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hh-tracker-db"
database_id = "PASTE_DATABASE_ID_HERE"
```

## 3. Применить миграции

```bash
npx wrangler d1 migrations apply hh-tracker-db
```

## 4. Секреты и переменные

### BOT_TOKEN

Токен бота из BotFather:

```bash
npx wrangler secret put BOT_TOKEN
```

### TELEGRAM_WEBHOOK_SECRET

Любая строка **только из** `A-Z a-z 0-9 _ -`.

Пример (40 символов):

```text
b7B7Cqk8d0mZcKQhT_2s5Lw1pR9kVn3aXy0uJ7sE
```

Задать:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### SHEET_URL (опционально)

Если хочешь оставить старую команду `/sheet` (ссылка одна для всех):

```bash
npx wrangler secret put SHEET_URL
```

## 5. Deploy

```bash
npx wrangler deploy
```

В конце увидишь URL воркера, например:

```text
https://hh-tracker-worker.<subdomain>.workers.dev
```

## 6. Настроить webhook Telegram

Открой в браузере (или curl):

```text
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<WEBHOOK_SECRET>&drop_pending_updates=true
```

Где:
- `<WORKER_URL>` — URL воркера после deploy
- `/telegram` — путь вебхука в этом проекте

## 7. Проверка

1) Напиши боту `/start`
2) `/new`
3) Вставь кусок списка откликов
4) `/done`
5) `/stats week`
6) `/report week`
7) `/export week`

## Про графики

Графики генерятся без Python — через внешний сервис QuickChart (Chart.js), и отправляются в Telegram как картинки.
Это значит:
- ничего не нужно запускать у пользователя на компе
- бот сам присылает картинки в чат

Если хочешь убрать внешнюю зависимость — можно переделать на генерацию PNG внутри отдельного бэкенда (не в Worker).
