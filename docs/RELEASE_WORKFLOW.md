# Выпуск Cloakwire

Основной путь выпуска — `scripts/build-all-platforms.ps1`. Он собирает Windows x64, Android arm64, macOS Apple Silicon и Intel из одного чистого коммита. Сборка и публикация выполняются отдельными командами. Версия берётся из `src-tauri/tauri.conf.json`.

## Один раз на машине выпуска

Нужны Node.js, Git, Rust с Windows/Android/macOS targets, Windows C++ Build Tools и WebView2, JDK 17, Android SDK/NDK, SSH/SCP, GitHub CLI. На Mac нужны Xcode command line tools, Node.js и Rust с обоими macOS targets.

Скопируйте конфигурацию и исправьте пути:

```powershell
Copy-Item scripts/release.local.example.psd1 release.local.psd1
```

`release.local.psd1` исключён из Git. В нём только пути и публичный отпечаток Android-сертификата. Укажите Windows/Mac sidecars, libbox.aar, Android JNI-библиотеки, каталог с geoip.dat и geosite.dat, приватный ключ обновлений и SSH known_hosts. Секретные ключи не копируются в архив исходников и опубликованные файлы.

Сохраняйте сертификат Android, которым подписаны установленные приложения. Текущие APK 1.4.8 используют существующий debug-сертификат; новый debug.keystore на другой машине имеет другой отпечаток. Проверка сертификата остановит такой выпуск. Для `AndroidBuildType = 'release'` задаются переменные процесса `CLOAKWIRE_ANDROID_KEYSTORE_PATH`, `CLOAKWIRE_ANDROID_KEYSTORE_PASSWORD`, `CLOAKWIRE_ANDROID_KEY_ALIAS` и `CLOAKWIRE_ANDROID_KEY_PASSWORD`; keystore должен находиться вне репозитория.

macOS-сборки пока подписываются ad hoc, без Apple notarization. Подписи обновлений Minisign проверяются отдельно на всех платформах.

## Подготовка версии

Явно измените версию перед следующим выпуском:

```powershell
npm run release:version -- set 1.4.9
npm run release:check
npm run release:test
npm test
npm run build
```

Команда синхронизирует package.json/package-lock.json, Cargo.toml/Cargo.lock и Android versionName/versionCode. Добавьте описание версии в CHANGELOG.md. Проверьте изменения приложения и инструменты выпуска, затем закоммитьте их. Сборщик отклоняет незакоммиченные изменения исходников: игнорируемые библиотеки и базы подключаются отдельно с записью их хешей.

`release:test` проверяет синхронизацию версий, подписи и манифесты, обработку ошибок команд, Android bootstrap и публикацию через локальный имитатор GitHub. Настоящие GitHub API и ключи подписи в тестах не используются. Первому запуску нужен доступ к зависимостям Cargo; Rust берётся из PATH или локальной конфигурации.

## Сборка

Запускайте из корня репозитория:

```powershell
npm run release:build -- -CheckOnly
npm run release:build
```

Можно передать `-ConfigPath`, ожидаемую `-Version` и отдельный `-NotesFile`. Без NotesFile используется раздел этой версии в CHANGELOG.md.

Каждый запуск создаёт новый каталог `BuildRoot/v<версия>-<идентификатор>` с исходным архивом, отдельными source/target/artifacts/logs и RELEASE_NOTES.md. Временные результаты прошлых запусков не подхватываются. Ошибка любой команды останавливает выпуск. Rust-тесты process/killswitch, меняющие состояние системы и сети, в этой процедуре исключены.

Android-служебные Gradle/Kotlin/ProGuard файлы создаются из используемых Tauri/Wry crates. Базы GeoIP/Geosite копируются в assets и проверяются внутри APK. Проверяются версия, архитектура, прежний Android-сертификат, свежесть результатов и комплект библиотек.

Готовый каталог artifacts содержит ровно семь установочных файлов:

| Платформа | Файлы |
| --- | --- |
| Windows x64 | EXE, MSI |
| Android arm64 | APK |
| macOS Apple Silicon | DMG, app.zip |
| macOS Intel | DMG, app.zip |

К ним добавляются семь .sig, latest.json с четырьмя платформами, два SHA256SUMS и release-build.json: всего 18 публикуемых файлов. В release-build.json записаны исходный коммит, хеш архива, даты и хеши бинарных входов/результатов, без локальных путей.

Все семь подписей криптографически проверяются публичным ключом приложения. Ошибки манифеста, контрольных сумм, имён или подписи блокируют выпуск.

## Публикация

Сохраните путь artifacts, выведенный сборщиком, в переменную `$dist`. Сначала можно проверить его без GitHub:

```powershell
npm run release:publish -- -DistPath $dist -ValidateOnly
```

Публикация требует авторизации GitHub CLI, чистого текущего HEAD и уже отправленного тега `v<версия>`, указывающего именно на коммит из release-build.json. Сборщик и издатель сами не создают и не отправляют Git-теги.

После отправки проверенного коммита и тега загрузите черновик:

```powershell
npm run release:publish -- -DistPath $dist
```

Команда загружает только ожидаемые 18 файлов и сверяет каждый SHA-256 с digest GitHub. При обрыве запустите её повторно: совпадающие файлы сохраняются, недостающие загружаются. Неправильный или посторонний файл требует проверки черновика вручную; автоматической перезаписи нет. Описание можно обновить через `-NotesFile`.

Просмотрите черновик и выполните явную публикацию:

```powershell
npm run release:publish -- -DistPath $dist -Publish
```

Перед публикацией повторяются проверки. Версия должна быть выше фактической latest и всех публичных стабильных выпусков. После публикации проверяется latest и полный комплект его файлов. Уже опубликованный выпуск команда не изменяет.

Существующие GitHub workflows Android/macOS остаются отдельными проверками компиляции. Их результаты не подменяют комплект из этой процедуры.
