<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire" width="128" />

# Cloakwire

**Кроссплатформенный VPN-клиент с двумя ядрами: sing-box и Xray.**

Windows · Linux · macOS · Android — Tauri 2, Rust, React и нативный Android VPNService.

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/markwhite7881-cpu/cloakwire?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/stargazers)

[English](README.en.md) · [Скачать](https://github.com/markwhite7881-cpu/cloakwire/releases/latest) · [Сообщить об ошибке](https://github.com/markwhite7881-cpu/cloakwire/issues)

</div>

---

## Что такое Cloakwire

Cloakwire превращает подписку или share-link в готовое VPN-подключение без ручного редактирования JSON. Клиент умеет запускать **sing-box** и **Xray**, показывает активное ядро и его версию, сохраняет выбранный сервер и предоставляет безопасную диагностику без раскрытия ключей подписки.

### Главное

- **Два ядра:** sing-box и Xray на desktop и Android.
- **Подписки и ссылки:** VLESS, VMess, Trojan, Shadowsocks, Hysteria2 и TUIC; обычный текст, Base64, Clash/Mihomo YAML и совместимые JSON-конфигурации.
- **Маршрутизация по приложениям:** приложения через VPN или напрямую; выбор процессов на desktop и пакетов Android.
- **TUN и System Proxy:** системный туннель, локальный SOCKS/HTTP proxy или комбинированный режим там, где это поддерживает ОС.
- **Управляемые подписки:** название провайдера, интервальное обновление, HWID, безопасная смена профиля и восстановление последнего сервера.
- **Наблюдаемость:** задержка, трафик, время соединения, версии ядер, экспорт диагностического отчёта и редактированные логи.
- **Без телеметрии:** настройки и секреты остаются локально; чувствительные данные не попадают во frontend-логи.

## Что нового в 1.3.2

- **Полноценная поддержка sing-box на Android** рядом с Xray. Выбор ядра из JS доведён до Kotlin `VpnService` через новый `CloakwirePlatform.kt` и `XrayAppRoutingPolicy.kt`.
- **Плитка Quick Settings на Android** теперь рисует настоящий глиф иконки приложения (PNG белого глифа на прозрачном фоне, density-specific, отскейлен на 96 % canvas, с жёстким alpha-порогом — ColorOS / OnePlus monochrome theming больше не делает белый блоб).
- **Запоминание последнего сервера на Android**: выбор (profile tag или bundle child) сохраняется в `localStorage` после каждого успешного connect и восстанавливается на cold start, с 5-секундным таймаутом на гидрацию подписок. Auto-connect гейтится на восстановлении, чтобы не стрельнул дефолтным `profiles[0]`.
- **Share-link connect использует выбранный профиль**, а не первый в списке. `useVpnConnection` получает `selected-first` копию, и xray выходит через outbound, который реально выбрал пользователь.
- **Кастомный signed апдейтер**: desktop-клиент использует свой апдейтер (`src-tauri/src/app_update.rs`), который тянет `latest.json` из релиза, проверяет GitHub origin и все редиректы, и валидирует **minisign**-подпись скачанного бинарника против публичного ключа, вшитого в бинарь. Публичный ключ совпадает с `src-tauri/.tauri-updater.key.pub`.
- **Linux release pipeline**: новый `.github/workflows/release-linux.yml`, скрипты `build-linux-local.sh`, `build-macos-local.sh`, `prepare-xray-sidecar.py` и `xray-core-assets.json` — AppImage / deb и macOS-сборки воспроизводятся из CI.
- **Чистка desktop `xray.rs` / `singbox.rs` / `process.rs`**: меньше поверхность, то же поведение, ложится в новый sidecar-манифест.
- **Desktop subscription layer**: новые `subscriptions/classify.rs`, `subscriptions/hwid.rs`, `SubscriptionIdentityCard.tsx`, `diagnostics.ts`. Старые share-link / sing-box / xray пути сохранены.
- Усилены проверки sidecar-бинарников, архивов, хешей, логов и границ между backend и UI.

---

## Установка

Скачивайте файлы только со страницы [GitHub Releases](https://github.com/markwhite7881-cpu/cloakwire/releases/latest). В каждом релизе публикуются `SHA256SUMS.txt` и подписанный `latest.json` для автообновления desktop.

### Windows x64

> _В v1.3.2 Windows-артефакт не публикуется. Самый свежий Windows-билд — это
> NSIS-инсталлятор v1.3.1. Следующий релиз восстановит Windows-артефакт;
> прогресс можно отслеживать в
> [milestone](https://github.com/markwhite7881-cpu/cloakwire/milestones)._

Windows SmartScreen может показать предупреждение о неизвестном издателе:
подпись обновления Cloakwire не заменяет коммерческую Authenticode-подпись.

### Linux x86_64

- `Cloakwire_1.3.2_amd64.deb` — рекомендуемый пакет для Debian / Ubuntu и TUN.
- `Cloakwire_1.3.2_amd64.AppImage` — переносимый вариант.

```bash
sudo apt install ./Cloakwire_1.3.2_amd64.deb
cloakwire
```

DEB post-install назначает sing-box `cap_net_admin` и `cap_net_raw`. AppImage
находится в read-only SquashFS, поэтому для надёжной работы TUN
используйте DEB.

### macOS

- `Cloakwire_1.3.2_aarch64.dmg` — Apple Silicon.
- `Cloakwire_1.3.2_x64.dmg` — Intel.
- `Cloakwire_1.3.2_aarch64.app.zip` / `Cloakwire_1.3.2_x64.app.zip` — `.app`
  бандлы для диагностики.

Сборки 1.3.2 пока **не подписаны Apple Developer ID и не нотаризованы**. При
первом запуске используйте правый клик → **Open**, либо разрешите
приложение в Privacy & Security.

### Android

- `Cloakwire_1.3.2_arm64-v8a.apk` — подписанный release APK для 64-битных
  ARM-устройств.
- `.idsig` — APK Signature Scheme v3 ID (для Play Store incremental install).
- `.verify.txt` — цепочка сертификата подписи и SHA-256 для ручной
  проверки.

Android поддерживает оба ядра. **sing-box работает внутри процесса
приложения**, **Xray запускается как защищённый VPNService sidecar**.

---

## Быстрый старт

1. Откройте **Servers** и добавьте URL подписки или share-link.
2. Выберите сервер и ядро: **sing-box** или **Xray**.
3. При необходимости настройте **Apps via VPN** и **Apps direct**.
4. Для полного туннеля выберите **TUN**.
5. Нажмите кнопку подключения на Home.

## Безопасность и проверка релиза

```bash
sha256sum -c SHA256SUMS.txt
```

Для автообновления desktop Rust-бэкенд (`src-tauri/src/app_update.rs`)
загружает `latest.json` с
`https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/latest.json`,
проверяет GitHub origin и все редиректы, скачивает инсталлятор для
текущей платформы и проверяет minisign-подпись перед запуском. Тот же
приватный ключ подписывает все три desktop-инсталлятора
(`linux-x86_64`, `darwin-aarch64`, `darwin-x86_64`); бэкап лежит в
`C:\Users\Алексей\.minimax-agent\projects\singbox-client\src-tauri\.tauri-updater.key`
(потеря = сломанные будущие обновления).

Android APK подписаны Android release-сертификатом
(`SHA-256 07c14843f191d7f85df335709e0859887bc790f9b0074b98481246638dee2ca1`),
это отдельная сущность от minisign-подписи апдейтера.

- подписочные URL, UUID и токены остаются в backend;
- runtime-конфиги и логи проходят редактирование чувствительных данных;
- загружаемые ядра проверяются по закреплённым SHA-256;
- архивы распаковываются с защитой от path traversal;
- проект не содержит аналитики и рекламных SDK.

## Разработка

```bash
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Платформенные release-скрипты находятся в `scripts/`, а CI-конфигурации — в `.github/workflows/`.

### Архитектура

```text
React + TypeScript UI
          │ Tauri IPC
Rust backend + subscription/config domain
          │
     ┌────┴────┐
  sing-box    Xray
          │
  TUN / proxy / Android VPNService
```

## Contributing

Issues и pull requests приветствуются. Перед отправкой изменений запустите
frontend-тесты, `cargo fmt --check` и Rust unit tests. Для крупных
изменений сначала создайте issue с описанием поведения и целевых
платформ.

## Лицензия

[MIT](LICENSE).

## Благодарности

- [sing-box](https://github.com/SagerNet/sing-box) и [sing-box-lx](https://github.com/Leadaxe/sing-box-lx)
- [Xray-core](https://github.com/XTLS/Xray-core)
- [Tauri](https://tauri.app/)
- разработчикам Rust, React и Android open-source экосистемы

<div align="center">

**Приватность без ручной настройки. Два ядра — один понятный клиент.**

</div>
