# HH Tracker (Cloudflare Worker + D1)

Это версия проекта под **GitHub → Cloudflare**, без Replit.

## Что пользователь в итоге получает

- Telegram-бот, куда можно:
  - `/new` → сбросить буфер
  - вставлять копипасту из hh.ru (можно частями)
  - `/done` → распарсить и сохранить
  - `/stats` → получить статистику за 30 дней
- Данные каждого пользователя хранятся **отдельно** (разделение по Telegram user_id).
- Хранение: **Cloudflare D1 (SQLite)**.
- Никакой Google Sheets в этой версии нет (позже добавим экспорт).

## 0. Что нужно установить локально

- Node.js 18+ (лучше 20)
- Git
- Wrangler (поставится как devDependency)

## 1. Подготовь репозиторий на GitHub

1) Создай новый repo (например `hh-tracker`).
2) Скопируй сюда содержимое этой папки.
3) Закоммить и запушь.

## 2. Создай D1 базу и привяжи в `wrangler.toml`

В корне проекта:

```bash
npm i
npx wrangler login
npx wrangler d1 create hh-tracker-db
```

Команда выведет `database_id`. Вставь его в `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hh-tracker-db"
database_id = "PASTE_DATABASE_ID_HERE"
```

## 3. Применить миграции (создать таблицы)

```bash
npx wrangler d1 migrations apply hh-tracker-db
```

## 4. Задать секреты (токены)

1) Токен бота из BotFather → в переменную `BOT_TOKEN`:

```bash
npx wrangler secret put BOT_TOKEN
```

2) Секрет вебхука (любая строка 20-40 символов, только A-Z a-z 0-9 _ -) → `TELEGRAM_WEBHOOK_SECRET`:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

## 5. Задеплоить Worker

```bash
npx wrangler deploy
```

В конце ты увидишь URL воркера (например `https://hh-tracker-worker.<...>.workers.dev`).

## 6. Привязать Telegram webhook

В браузере (или curl) открой такую ссылку:

```text
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<WEBHOOK_SECRET>&drop_pending_updates=true
```

- `<WORKER_URL>` — URL после deploy
- `/telegram` — путь вебхука в этом проекте

## 7. Проверка

1) Напиши боту `/start`.
2) `/new`.
3) Вставь кусок списка откликов.
4) `/done`.
5) `/stats`.

## Нюансы

- Telegram иногда ретраит апдейты, если вебхук отвечает не 2xx. Тут это учтено: `processed_updates` защищает от дублей.
- Бот отвечает “Принял…” не чаще 1 раза в 5 секунд.



## Команды бота

- `/new` — очистить буфер
- `/done` — распарсить и сохранить
- `/stats [7|30|90]` — статистика (по умолчанию 30 дней)
- `/funnel [7|30|90]` — воронка картинкой
- `/trend [7|30|90]` — график откликов по дням
- `/table [n]` — последние n строк таблицей
- `/export [7|30|90|all]` — CSV-файл (для Excel/Google Sheets)

> Google Sheets интеграция отключена (без Google Cloud).
