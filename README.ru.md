<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire Logo" width="112" />

# Cloakwire

**Кросс-платформенный privacy-first VPN-клиент нового поколения с двойным движком sing-box + Xray и интерфейсом в стиле Linear Bento.**

Windows · macOS · Linux · Android · Нативный Rust/Tauri · VLESS Reality / Hysteria 2 / TUIC · 0 логов · 100% Open Source

<br/>

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge&color=10b981)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge&color=3b82f6)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-blueviolet?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge&color=64748b)](LICENSE)

<br/>

**[ 🇬🇧 English version (README.md) ](README.md)**

<br/>

<img src="screenshots/hero-showcase.png" alt="Cloakwire Linear Bento Showcase" width="100%" />

</div>

---

## ⚡ Быстрая загрузка релизной версии (v1.4.0)

| Платформа | Рекомендуемый установщик | Альтернативный пакет | Архитектура |
|---|---|---|---|
| 🪟 **Windows** | [⬇️ **Скачать .exe** (NSIS)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64-setup.exe) | [⬇️ **Скачать .msi**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64_en-US.msi) | x64 (Intel / AMD) |
| 🍏 **macOS Apple Silicon** | [⬇️ **Скачать .dmg**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_aarch64.dmg) | [⬇️ **Скачать .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_aarch64.app.zip) | M1 / M2 / M3 / M4 |
| 🍏 **macOS Intel** | [⬇️ **Скачать .dmg**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64.dmg) | [⬇️ **Скачать .app.zip**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_x64.app.zip) | x86_64 |
| 🐧 **Linux** | [⬇️ **Скачать .deb** (Ubuntu / Debian)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_amd64.deb) | [⬇️ **Скачать .AppImage** (Портативный)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_amd64.AppImage) | x86_64 |
| 🤖 **Android** | [⬇️ **Скачать .apk**](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/Cloakwire_1.4.0_arm64-v8a.apk) | — | arm64-v8a |

> 🔒 Все бинарные файлы подписаны ключом **Minisign** (`.sig`) и проверены контрольными суммами в [`SHA256SUMS.txt`](https://github.com/markwhite7881-cpu/cloakwire/releases/latest/download/SHA256SUMS.txt).

---

## 🚀 Быстрый старт за 3 шага

```
 1. Скачайте и установите       2. Вставьте ссылку подписки / узла       3. Нажмите кнопку Connect
┌────────────────────────┐   ┌───────────────────────────────────┐   ┌────────────────────────┐
│  Выберите пакет под    │──▶│  Вставьте vless://, ss://, hy2:// │──▶│  Быстрый и свободный   │
│  Windows, Mac или phone│   │  или ссылку Base64 / Clash подписки│   │  интернет без цензуры  │
└────────────────────────┘   └───────────────────────────────────┘   └────────────────────────┘
```

1. **Установите Cloakwire** из таблицы загрузок выше.
2. Нажмите **Add Server** или вставьте ссылку на сервер/подписку (`vless://`, `vmess://`, `ss://`, `trojan://`, `hy2://`, `tuic://`, `wireguard://` или URL подписки).
3. Нажмите центральную кнопку **Power**. Весь трафик мгновенно защищен, зашифрован и устойчив к блокировкам.

---

## 🛡️ Безопасность, приватность и прозрачность

### Почему Windows SmartScreen или macOS Gatekeeper показывают предупреждение?
Cloakwire — это **100% бесплатный проект с открытым исходным кодом**. Мы не монетизируем продукт рекламой и не покупаем коммерческие сертификаты Microsoft EV ($400+/год) и Apple Developer ($99/год).
- **Windows SmartScreen**: Нажмите **«Подробнее»** → **«Выполнить в любом случае»**.
- **macOS Gatekeeper**: Кликните правой кнопкой мыши по `Cloakwire.app` → выберите **«Открыть»** (или разрешите в *Системные настройки → Конфиденциальность и безопасность*).
- **Проверка подлинности**: Вы можете проверить контрольные суммы любого скачанного файла по `SHA256SUMS.txt` или сверить Minisign-сигнатуру.

```powershell
# Проверка хеша Windows-инсталлятора:
(Get-FileHash Cloakwire_1.4.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
```

### Гарантия приватности
- **0 логов, 0 телеметрии**: Приложение не собирает метрики, не отправляет дампы и не имеет трекеров.
- **Защищенный DNS через туннель**: Системные DNS-запросы шифруются через DoH (`dns.google`) прямо внутри VPN-туннеля, что полностью исключает перехват и подмену DNS локальным провайдером.
- **Изоляция подписок**: Парсинг подписок и токенов происходит в нативном Rust-бэкенде без утечки данных в веб-слой.

---

## ⚔️ Почему Cloakwire? (Сравнение)

| Возможность | Cloakwire | v2rayN | Clash Verge / Mihomo | Hiddify |
|---|---|---|---|---|
| **Интерфейс** | **Linear Bento Dark UI (быстрый, чистый)** | Устаревший WinForms (из 2000-х) | Перегружен YAML-конфигами | Flutter (тяжелые анимации) |
| **Потребление ресурсов** | **⚡ Нативный Rust/Tauri (<35 МБ RAM)** | 🐢 Среда .NET (~120 МБ RAM) | Electron (~150 МБ RAM) | Flutter Runtime (~100 МБ RAM) |
| **Двойное ядро** | **✅ sing-box + Xray (авто-fallback)** | ⚠️ Ручное переключение ядер | ❌ Только Clash/Mihomo | ⚠️ Только sing-box |
| **График трафика** | **✅ 60 FPS Canvas волна в реальном времени** | ❌ Только текстовые счетчики | ⚠️ Базовый SVG-график | ⚠️ Простой график |
| **Умный роутинг** | **✅ 1 клик: «Приложения через VPN» / «Напрямую»** | ⚠️ Сложные regex-правила | ⚠️ Сложные правила YAML | ⚠️ Базовый per-app |
| **Современные протоколы** | **✅ VLESS Reality, Vision, Hysteria 2, TUIC** | ✅ Все протоколы | ⚠️ Ограниченная поддержка | ✅ Все протоколы |
| **Платформы** | **Windows, macOS, Linux, Android** | Только Windows | Windows, macOS, Linux | Кросс-платформенный |

---

## 🌟 Ключевые возможности

### 🎨 Дизайн Linear Bento UI
Современный темный интерфейс в эстетике профессиональных инженерных инструментов: высококонтрастная палитра zinc, мягкое изумрудное свечение, счетчики скорости в КБ/с и аппаратная 60 FPS волна трафика.

### 🧩 Интеллектуальный двойной движок
- **sing-box (основной)**: Сверхбыстрая обработка пакетов, системный TUN-режим, раздельное туннелирование по приложениям и автовыбор самого быстрого узла по пингу.
- **Xray Core (автоматический fallback)**: Автоматически подхватывает специфичные бандлы и профили подписок, требующие расширений Xray, без сбоев интерфейса.

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
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libayatana-appindicator3-dev`

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