# HH Tracker (Cloudflare Worker + D1)

Это версия проекта под **GitHub → Cloudflare**, без Replit.

## Что пользователь в итоге получает

- Telegram-бот, куда можно:
  - `/new` → сбросить буфер
  - вставлять копипасту из hh.ru (можно частями)
  - `/done` → распарсить и сохранить
  - `/stats` → получить статистику за 30 дней
  - `/connect you@gmail.com` → создать таблицу Google Sheets и подключить экспорт
  - `/sheet` → ссылка на таблицу
  - `/sync` → пересобрать таблицу из базы
- Данные каждого пользователя хранятся **отдельно** (разделение по Telegram user_id).
- Хранение: **Cloudflare D1 (SQLite)**.
- Есть экспорт в Google Sheets: /connect <email> создаёт личную таблицу и дальше /done автоматически дописывает новые строки.

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



## 4. Экспорт в Google Sheets (создание таблицы для каждого пользователя)

Схема такая: воркер создаёт таблицу **в аккаунте service account** и шарит её на email пользователя (таблица появится в Google Drive → "Доступные мне").

### 4.1 Создай service account и ключ

1) Google Cloud Console → создай проект
2) Включи API:
   - Google Sheets API
   - Google Drive API
3) Создай Service Account и скачай ключ **JSON**

### 4.2 Добавь секрет в Cloudflare Worker

Workers & Pages → hh-tracker-worker → Settings → Variables → Secrets:

- `GOOGLE_SERVICE_ACCOUNT_JSON` = содержимое скачанного JSON (целиком)

### 4.3 Подключение пользователем

В Telegram:

- `/connect you@gmail.com`

Бот создаст таблицу, расшарит на email и даст ссылку. Дальше после `/done` новые строки будут автоматически добавляться в таблицу.
