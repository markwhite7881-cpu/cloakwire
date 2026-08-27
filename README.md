<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire" width="128" />

# Cloakwire

**Privacy-first VPN-клиент для Windows, macOS, Linux и Android с двумя движками: sing-box и Xray.**

Tauri 2 + React + TypeScript.

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?include_prereleases&sort=semver&style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/stargazers)

</div>

> 🇬🇧 **English version:** [README.en.md](README.en.md)

---

## 🎯 Что это такое

**Cloakwire** — минималистичный VPN-клиент для Windows, macOS, Linux и Android. Он принимает share-links и подписки, сохраняет конфигурации локально и запускает профиль в понятном интерфейсе без ручного редактирования JSON.

**sing-box — основной движок.** Используется на всех платформах для TUN, System Proxy, маршрутизации по приложениям, выбора прокси и встроенных проверок задержки.

**Xray — fallback по возможностям.** Если подписка содержит профиль, который безопаснее или корректнее исполнять через Xray, Cloakwire подготавливает и запускает его автоматически. На Home при этом сохраняется статус, выбранный сервер и live-метрики. Управление proxy-группами и встроенные delay-тесты доступны только при активном sing-box — это ограничение намеренное, а не ошибка интерфейса.

### Что нового в 1.3.2

- **Android: dual-engine.** Xray больше не единственный вариант. На Android работают оба движка: sing-box работает внутри процесса приложения, Xray — как защищённый sidecar `VpnService`. Выбор ядра в Settings применяется end-to-end через `CloakwirePlatform.kt`.
- **Android: Quick Settings tile.** Вместо серого power-иконки в плитке теперь реальный глиф иконки приложения (white-on-transparent, density-specific, отскейлен на 96 % canvas, с жёстким alpha-порогом). ColorOS / OnePlus monochrome theming больше не рисует белый блоб.
- **Android: last-server persistence.** Выбор профиля (tag или bundle child) сохраняется в `localStorage` при каждом успешном connect и восстанавливается на cold start, с 5-секундным таймаутом на гидрацию подписок. Auto-connect гейтится на восстановлении, чтобы не стрельнул дефолтным `profiles[0]`.
- **Picked-row actually picks.** Share-link connect больше не отправляет в Rust собранный порядок профилей — xray выходит через outbound, который реально выбрал пользователь.
- **Custom signed update manifest.** `latest.json` теперь в каждом релизе: `src-tauri/src/app_update.rs` тянет его с GitHub, проверяет GitHub origin и все редиректы, верифицирует **minisign**-подпись скачанного бинарника против вшитого публичного ключа. Public key — это `src-tauri/.tauri-updater.key.pub` в репо.
- **Linux release pipeline.** Новые `.github/workflows/release-linux.yml`, `scripts/build-linux-local.sh`, `prepare-xray-sidecar.py`, `xray-core-assets.json` — AppImage/deb и macOS-сборки воспроизводятся из CI.

### Управляйте маршрутом, а не настройками сети

**Apps via VPN.** Выберите браузер, игру, мессенджер или другое приложение — только их соединения пойдут через VPN-туннель. Остальной трафик продолжит работать напрямую.

**Apps direct.** Или наоборот: направьте через VPN системный трафик и оставьте прямое соединение только для выбранных приложений — например, банковских клиентов, корпоративных сервисов или программ в локальной сети.

---

## ✨ Возможности

| | |
|---|---|
| 🚀 **Быстрый старт** | Share-link или подписка → профиль готов к подключению |
| 🧩 **Два движка** | sing-box — основной на всех платформах; Xray — fallback для совместимых профилей |
| 📱 **Android dual-engine** | На Android оба ядра (sing-box in-process, Xray в sidecar `VpnService`) |
| 🎯 **Per-app маршруты** | «Telegram через VPN, банк напрямую» — в одном интерфейсе |
| 🗂️ **Подписки без утечек** | Подписки разбираются в backend; URL и содержимое профилей не передаются WebView |
| 🧭 **Понятный Home** | Серверы одной подписки сгруппированы, названия провайдера используются как fallback |
| 🔄 **Безопасное переподключение** | При смене сервера или рабочих Config/Routing-настроек активный VPN переподключается автоматически |
| 📈 **Live-статус** | Состояние соединения, трафик и информация о текущем движке |
| 🔐 **Подписанный апдейтер** | `latest.json` с minisign-подписями для desktop auto-update |
| 🔓 **Open Source** | MIT, без аналитики и телеметрии |

Поддерживаемые link-протоколы включают VLESS, VMess, Trojan, Shadowsocks, Hysteria2 и TUIC. Реальная совместимость конкретного профиля определяется его параметрами и выбранным движком.

---

## 📥 Установка

Скачивайте файлы из **[Releases → Latest](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)**. Ниже перечислен состав текущего релиза `v1.3.2`.

### Windows x64

> ⚠️ Windows-артефакт не публикуется в v1.3.2. Самый свежий Windows-билд — это NSIS-установщик `v1.3.1`. Следующий релиз восстановит Windows-артефакт; прогресс можно отслеживать в [milestone](https://github.com/markwhite7881-cpu/cloakwire/milestones).

### macOS

| Mac | Файлы |
|---|---|
| Intel | `Cloakwire_1.3.2_x64.dmg` или `Cloakwire_1.3.2_x64.app.zip` |
| Apple Silicon | `Cloakwire_1.3.2_aarch64.dmg` или `Cloakwire_1.3.2_aarch64.app.zip` |

> ⚠️ Сборки `v1.3.2` не подписаны и не notarized. macOS может потребовать явного разрешения на запуск в настройках Privacy & Security. `.app.zip` архивы также приложены для диагностики.

### Linux x86_64 — Ubuntu / Debian

Установите пакет:

```bash
sudo apt install ./Cloakwire_1.3.2_amd64.deb
cloakwire
```

Пакет устанавливает `/usr/bin/cloakwire`, `sing-box` и Xray. Его `postinst` выдаёт `sing-box` capability `cap_net_admin,cap_net_raw=+ep`, необходимую для TUN-режима:

```bash
getcap /usr/bin/sing-box
# ожидается: /usr/bin/sing-box cap_net_admin,cap_net_raw=ep
```

Если capability была сброшена обновлением или ручным изменением прав, восстановите её:

```bash
sudo setcap cap_net_admin,cap_net_raw=+ep /usr/bin/sing-box
```

Также доступен portable-вариант `Cloakwire_1.3.2_amd64.AppImage`. AppImage не может сохранять file capabilities (read-only SquashFS), поэтому для гарантированной работы TUN рекомендуется DEB.

Linux-сборка рассчитана на Ubuntu 22.04+ и Debian 12+ desktop. TUN рекомендуется: он перехватывает трафик на сетевом уровне и не зависит от proxy-поддержки конкретного приложения.

### Android

- `Cloakwire_1.3.2_arm64-v8a.apk` — подписанный release APK для 64-битных ARM-устройств.
- `Cloakwire_1.3.2_arm64-v8a.apk.idsig` — APK Signature Scheme v3 ID (для Play Store incremental).
- `Cloakwire_1.3.2_arm64-v8a.apk.verify.txt` — цепочка сертификата и SHA-256 для ручной проверки.

Android поддерживает оба ядра. **sing-box работает в процессе приложения**, **Xray — как защищённый sidecar `VpnService`**. Переключение — в Settings → Engine.

### Проверка загрузки

Сверяйте SHA-256 с контрольными суммами в `SHA256SUMS.txt`. Пример:

```powershell
Get-FileHash .\Cloakwire_1.3.2_x64-setup.exe -Algorithm SHA256
```

Кроссплатформенный аналог:

```bash
sha256sum -c SHA256SUMS.txt
```

Несовпадение хеша означает повреждённый или подменённый файл — скачивайте заново.

---

## 🚀 Первый запуск

1. Запустите **Cloakwire**. Для TUN-режима подтвердите повышение прав.
2. В **Servers** вставьте share-link (`vless://...&`) или URL подписки и нажмите **Add**.
3. В **Routing** добавьте приложения, которым нужен VPN, в **Apps via VPN** или оставьте **Apps direct**.
4. В **Config** выберите режим работы — **TUN** (рекомендуется), **System Proxy**, **Both** или **None**. Поля DNS-серверов остаются пустыми, если вы хотите использовать DNS-сервер провайдера.
5. На **Home** выберите сервер и нажмите кнопку подключения.

Если VPN сбился при смене сервера или активной настройки — Cloakwire автоматически переподключается. Чтобы избежать двойных нажатий и нестабильных перезапусков, все переподключения идут через backend-очередь с дебаунсом.

---

## 🖼️ Интерфейс

### Home — экран подключения

Показывает выбранный профиль, live Download/Upload и кнопку переподключения. Backend автоматически сбрасывает состояние Home на «не подключено» только при смене сервера или Config/Routing.

![Home tab](dist-release/screenshots/01-home.png)

### Servers — подписки и профили

Добавляйте share-link и подписки в URL, base64 и Clash YAML. Формат определяется автоматически; пользовательский парсинг профилей в backend остаётся прозрачным.

![Servers tab](dist-release/screenshots/02-servers.png)

### Config — режим работы и DNS

Четыре режима: **TUN**, **System Proxy**, **Both** и **None**. Поля DNS-серверов остаются пустыми, если вы хотите использовать DNS-сервер провайдера.

![Config tab](dist-release/screenshots/03-config.png)

### Routing — простой и продвинутый

В простом режиме — **Apps via VPN** и **Apps direct**. В Advanced доступны кастомные правила, rule-sets, sniffing, auto-detect interface и final outbound.

![Routing tab — simple UX](dist-release/screenshots/04-routing.png)
![Routing tab — Advanced](dist-release/screenshots/05-routing-advanced.png)

---

## 🏗️ Архитектура

```text
React + TypeScript + Tailwind     ← typed tauri::invoke
          │
src/
          │
Rust + Tauri 2                  ← подписки, роутинг, lifecycle, безопасный IPC
src-tauri/src/
          │
     ┌────┴────┐
  sing-box    Xray
  (primary)    (fallback)
          │
  TUN / proxy control · Android sidecar VPNService
```

`sing-box` — основной движок на всех платформах, исполняет типичные поддерживаемые профили. На Android работает в процессе приложения; на десктопе — как sidecar.

`Xray` — fallback-движок по возможностям. Cloakwire подготавливает и запускает его автоматически, если подписка содержит профиль, который безопаснее или корректнее исполнять через Xray.

---

## 🛠️ Стек

| Слой | Технология |
|---|---|
| Shell | **Tauri 2** (Rust + WebView) |
| UI | **React 18** + **TypeScript 5** |
| Стили | **Tailwind CSS 3** + design tokens |
| Основной VPN-ядро | [sing-box](https://github.com/SagerNet/sing-box) (sidecar) |
| Fallback-ядро | [Xray-core](https://github.com/XTLS/Xray-core) (sidecar) |
| Маршрутизация | sing-box rules / rule-sets + process routing |
| Автообновление | кастомный updater; minisign-подписи встроены в `latest.json`, которое лежит в каждом релизе |
| Runtime-обновление | managed update в CI для sing-box; обновление Xray вручную не включено, потому что профили чувствительны к версии |

---

## 🔐 Безопасность и границы данных

- URL подписки, share-link, UUID и runtime-конфиги хранятся в backend; WebView не получает их.
- `Xray` runtime-команды и его stdout/stderr логируются только backend-стороной.
- При обновлении Xray он не запускается в sing-box Clash API для маршрутизации или delay-тестов.
- Нет аналитики и телеметрии, нет посторонних SDK.
- Обновления и загружаемые ядра проверяются по закреплённым SHA-256; для новых релизов сверяйте с `SHA256SUMS.txt`.

---

## 🧑‍💻 Сборка из исходников

```powershell
# Требования: Node 20+, Rust stable, готовый Tauri для desktop-разработки
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm run tauri:build
```

Для Linux `.deb` используется Ubuntu 22.04+ / Debian 12+ (или WSL2) и AOT-компиляция:

```bash
./scripts/build-linux-deb.sh 1.3.2
```

`postinst` в итоговом `.deb` САМОСТОЯТЕЛЬНО назначает capability `sing-box` (`cap_net_admin,cap_net_raw=+ep`), без этого Linux TUN-режим не работает.

---

## 🤝 Contributing

PR-к приветствуются. Перед отправкой изменений запустите локально проверки:

- **Code style:** `cargo fmt` для Rust, Prettier для TS/TSX.
- **Проверки:** `npm test`, плюс production build; прогоните на десктопе до создания PR.
- **Коммиты:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

---

## 📜 Лицензия

[MIT](LICENSE) — делайте с кодом что хотите, без гарантий.

---

## 🙏 Благодарности

- [SagerNet/sing-box](https://github.com/SagerNet/sing-box)
- [XTLS/Xray-core](https://github.com/XTLS/Xray-core)
- [Tauri](https://tauri.app)

---

<div align="center">

**[⬇ Скачать последнюю версию](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)** · **[🐛 Сообщить об ошибке](https://github.com/markwhite7881-cpu/cloakwire/issues)** · **[⭐ Поставить звезду](https://github.com/markwhite7881-cpu/cloakwire)**

Made with care for people who value their privacy.

</div>
