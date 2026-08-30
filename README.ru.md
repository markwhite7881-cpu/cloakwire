<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire Logo" width="112" />

# Cloakwire

**Кросс-платформенный privacy-first VPN-клиент нового поколения с двойным движком sing-box + Xray и интерфейсом в стиле Linear Bento.**

Windows · macOS · Android · Нативный Rust/Tauri · VLESS Reality / Hysteria 2 / TUIC · 0 логов · 100% Open Source

<br/>

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge&color=10b981)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge&color=3b82f6)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Android-blueviolet?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge&color=64748b)](LICENSE)

<br/>

**[ 🇬🇧 English Documentation (README.md) ](README.md)**

<br/>

<img src="screenshots/hero-showcase.png" alt="Cloakwire Linear Bento Showcase" width="100%" />

</div>

---

## ⚡ Быстрая загрузка релизной версии (v1.4.2)

| Платформа | Рекомендуемый установщик | Альтернативный пакет | Архитектура |
|---|---|---|---|
| 🪟 **Windows** | [⬇️ **Скачать .exe** (NSIS)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_x64-setup.exe) | [⬇️ **Скачать .msi**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_x64_en-US.msi) | x64 (Intel / AMD) |
| 🍏 **macOS Apple Silicon** | [⬇️ **Скачать .dmg**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_aarch64.dmg) | [⬇️ **Скачать .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_aarch64.app.zip) | M1 / M2 / M3 / M4 |
| 🍏 **macOS Intel** | [⬇️ **Скачать .dmg**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_x64.dmg) | [⬇️ **Скачать .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_x64.app.zip) | x86_64 |
| 🤖 **Android** | [⬇️ **Скачать .apk**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.2_arm64-v8a.apk) | — | arm64-v8a |

> 🔒 Все десктопные бинарные файлы подписаны ключом **Minisign** (`.sig`) и проверены контрольными суммами в [`SHA256SUMS.txt`](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/SHA256SUMS.txt).

---

## 🚀 Быстрый старт

### 1. Скачайте и установите
Выберите инсталлятор или портативный пакет для вашей ОС из таблицы выше.

### 2. Добавьте узел или подписку
Нажмите **Add Server** или вставьте ссылку (`vless://`, `vmess://`, `ss://`, `trojan://`, `hy2://`, `tuic://`, `wireguard://` или URL подписки). Приложение автоматически распознает ссылки из буфера обмена.

### 3. Подключитесь
Нажмите центральную кнопку **Power**. Защищенный туннель включится мгновенно с параллельной проверкой пинга и защитой от перехвата DNS.

---

## 🛡️ Безопасность, приватность и проверка

### Почему Windows SmartScreen или macOS Gatekeeper показывают предупреждение?
Cloakwire — это **100% бесплатное открытое ПО**. Мы не приобретаем дорогостоящие корпоративные сертификаты Microsoft EV ($400+/год) и Apple Developer ($99/год).
- **Windows SmartScreen**: Нажмите **«Подробнее»** → **«Выполнить в любом случае»**.
- **macOS Gatekeeper**: Кликните правой кнопкой по `Cloakwire.app` → выберите **«Открыть»** (или разрешите в *Системные настройки → Конфиденциальность и безопасность*).
- **Проверка подлинности**: Все десктопные пакеты снабжены Minisign-подписями (`.sig` на странице релизов) и хешами SHA-256 в `SHA256SUMS.txt`. Все сборочные скрипты и исходный код открыты для аудита в этом репозитории.

```powershell
# Проверка хеша Windows-инсталлятора:
(Get-FileHash Cloakwire_1.4.2_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
```

### Гарантии приватности
- **0 логов и телеметрии**: Полное отсутствие трекеров, аналитики и отправки дампов.
- **Шифрование DNS**: В режиме прокси DNS-запросы направляются через DoH (`dns.google`) внутри зашифрованного туннеля, что исключает подмену DNS провайдером.
- **Изоляция подписок**: Декодирование подписок и ключей происходит в Rust-бэкенде без утечки данных в веб-слой.

---

## ⚔️ Сравнение архитектур и подходов

| Характеристика | Cloakwire | v2rayN | Clash Verge / Mihomo | Hiddify |
|---|---|---|---|---|
| **Интерфейс** | **Linear Bento UI (React/Tailwind)** | Классический .NET / WinForms | Web/Electron | Flutter multi-platform |
| **Память в простое (RAM)** | **~35 МБ (Rust + OS Webview)** | ~120 МБ (.NET runtime) | ~150 MB (Chromium helper) | ~100 МБ (Flutter engine) |
| **Архитектура ядер** | **sing-box + Xray (авто-fallback)** | Ручной выбор ядра | Mihomo (Clash Meta) | Ядро sing-box |
| **График трафика** | **60 FPS Hardware Canvas волна** | Текстовые счетчики | SVG/Canvas график | Canvas график |
| **Разделение трафика** | **1 клик: «Приложения через VPN» / «Напрямую»** | Regex-правила маршрутизации | Наборы правил YAML | Выбор приложений |
| **Поддержка протоколов** | **VLESS, VMess, Trojan, SS, Hysteria 2, TUIC** | Полная поддержка | Зависит от ядра | Полная поддержка |
| **Платформы** | **Windows, macOS, Android** | Windows | Windows, macOS, Linux | Кросс-платформенный |

---

## 🌟 Ключевые возможности

### 🎨 Дизайн Linear Bento UI
Минималистичный темный интерфейс: высококонтрастная палитра zinc, мягкое изумрудное свечение, счетчики скорости в КБ/с и аппаратная 60 FPS волна трафика.

### 🧩 Интеллектуальный двойной движок
- **sing-box (основной)**: Сверхбыстрая обработка пакетов, системный TUN-режим, раздельное туннелирование по приложениям и автовыбор самого быстрого узла по пингу.
- **Xray Core (автоматический fallback)**: Автоматически подхватывает конфигурации, требующие специфичных расширений Xray, без сбоев интерфейса.

### 🎯 Раздельное туннелирование (Split Routing)
- **Приложения через VPN**: Направьте только нужные программы (Telegram, Discord, браузер) через защищенный туннель, оставив остальной интернет на максимальной скорости провайдера.
- **Приложения напрямую**: Пустите весь трафик через VPN, исключив чувствительные сервисы (банки, Госуслуги, локальную сеть).

### 🌐 Автоопределение флагов стран и пинг
- Автоматически распознает ISO-коды и флаги стран (🇳🇱 Нидерланды, 🇩🇪 Германия, 🇪🇪 Эстония и др.) в названиях серверов.
- Параллельно измеряет задержку (мс) до каждого сервера и выводит шкалу качества связи.

---

## 📱 Скриншоты

<div align="center">
  <img src="screenshots/01-home.png" alt="Главный экран" width="48%" />
  <img src="screenshots/02-servers.png" alt="Список серверов" width="48%" />
</div>
<div align="center">
  <img src="screenshots/04-routing.png" alt="Маршрутизация" width="48%" />
  <img src="screenshots/03-config.png" alt="Конфигурация" width="48%" />
</div>

---

<details>
<summary><b>🔧 Архитектура и поддерживаемые протоколы (Нажмите, чтобы развернуть)</b></summary>

<br/>

### Поддерживаемые протоколы

| Протокол | Транспорт и расширения | Ядро |
|---|---|---|
| **VLESS** | Reality, XTLS-Vision, WebSocket, gRPC, HTTPUpgrade, Splithttp | `sing-box` / `Xray` |
| **VMess** | TCP, WebSocket, gRPC, TLS | `sing-box` / `Xray` |
| **Trojan** | TLS, WebSocket, gRPC | `sing-box` / `Xray` |
| **Shadowsocks** | AEAD, 2022 (blake3, chacha20, aes-gcm) | `sing-box` / `Xray` |
| **Hysteria 2** | Порт-хоппинг, обфускация salamander, BBR | `sing-box` |
| **TUIC** | QUIC, 0-RTT рукопожатие, контроль перегрузок BBR | `sing-box` |
| **WireGuard / AWG** | Защищенный UDP-туннель | `sing-box` |

### Сборка из исходников

**Требования**:
- Node.js 20+ и npm
- Rust 1.80+ (`cargo`)
- Зависимости платформы:
  - **Windows**: Visual Studio 2022 C++ Build Tools, WiX Toolset v3, NSIS
  - **macOS**: Xcode Command Line Tools

```bash
# Клонирование репозитория
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire

# Установка зависимостей интерфейса
npm install

# Запуск в режиме разработки
npm run tauri:dev

# Сборка финального установщика
npm run tauri:build
```

</details>

---

## 📄 Лицензия

Cloakwire распространяется под лицензией **MIT License**. См. [`LICENSE`](LICENSE).
Встроенные бинарные ядра (`sing-box`, `Xray-core`) принадлежат их авторам и распространяются по открытым лицензиям GPL / MPL.