# Android: проверка изоляции диагностики, 2026-10-31

Проверка на подключённом CPH2747 (Android 16, arm64) завершена для двух рабочих ядер: sing-box и Xray. Обе найденные причины тайм-аутов устранены. Рабочее подключение сохраняется при запуске, отмене и аварии диагностического процесса.

Это завершение контрольной точки процессной изоляции D3. Произвольные пользовательские profiles, продуктовый API диагностики, новая кнопка и автовосстановление этим этапом не включаются.

## Две причины тайм-аутов

### DNS экспериментального адаптера

Эксперимент брал первый DNS из свойств Wi-Fi, удалял IPv6 zone и использовал адрес как UDP upstream для libbox. На телефоне это scoped link-local IPv6 DNS. Без zone прямой запрос из того же UID завершался SocketException; с исходной zone — тайм-аутом. При этом Android Network resolver, публичный UDP DNS и проверенный HTTPS из того же UID/физической Network работали. Добавление VpnService.protect не меняло этот результат.

Исправление: синтетический probe использует local DNS transport с Network.getAllByName на выбранной физической сети. HTTPS больше не зависит от первого DHCP DNS. Отдельный фиксированный UDP-запрос к 1.1.1.1 проверяет реальную передачу UDP через SOCKS5 и новый outbound binding. DNS рабочих профилей не менялся. Device regression требует, чтобы libbox действительно вызвал platform DNS transport.

Предыдущая ошибка выбора первой физической сети уже исправлена: выбирается активная физическая Network либо единственный однозначный кандидат. Смена маршрута при неудаче не разрешается.

### Потерянный fingerprint Xray Reality

Android-генератор переносил Reality key/SNI/short ID, но терял явно заданный TLS fingerprint. У того же сервера с теми же параметрами:

- защищённый SOCKS-посредник передавал HTTPS и устанавливал TCP к серверу;
- HTTPS через Xray с исходным сгенерированным config зависал;
- добавление только исходного fingerprint сразу давало HTTPS 204.

В xray_config.rs восстановлен перенос fingerprint в realitySettings. Исправление применяется к конфигурации сессии и временного latency-тестера. Пользовательские записи не редактировались; новый fingerprint не выбирался предположением.

Регрессия полного пути parse_link → session/latency config сначала упала с Null вместо firefox, затем прошла. В окончательном APK повторно проверено фактическое значение, возвращаемое Android-командой генерации: временная подмена в тестовом runner не использовалась.

## Изоляция и владение

Рабочие Xray-сессии и временный LatencyTester имеют отдельные process handles, уникальные config files и проверяемые owner records. Общая очистка по имени libxray.so/pkill удалена в предыдущем checkpoint. Закрытый владелец не может запуститься повторно; callbacks и отложенные restart привязаны к поколению сессии.

Экспериментальная служба находится только в src/debug:

- непубличный отдельный процесс :diagnostics;
- отдельный Binder-клиент :diagnostic_driver с системным разрешением DUMP;
- свои libbox paths, command secret и loopback listener;
- запрет TUN; DNS и исходящие TCP/UDP относятся к выбранной физической Network;
- отмена, deadline и гибель клиента закрывают только диагностику;
- отмена рабочего потока временного Xray запускает его собственную очистку.

Контрольные режимы не принимают пользовательские конфигурации или секреты. Xray lifetime fixture разрешает только loopback port, заданный через shell-only Activity. Вспомогательное test-only приложение также ограничено разрешением DUMP.

Применяются [Android Network API](https://developer.android.com/reference/android/net/Network) и [bound service/Binder](https://developer.android.com/develop/background-work/services/bound-services).

## Окончательная матрица на телефоне

APK SHA-256: `1673AC0E37E7C67C8AF8AEC54A927D702C1336AFB5EED7CFBE78871D7FA4D66C`.

| Рабочий VPN | Отдельный libbox probe | Временный реальный Xray |
|---|---:|---:|
| sing-box | 13 PASS | 8 PASS |
| Xray | 13 PASS | 8 PASS |

Всего **42 проверки изоляции**:

- рабочий run ID, engine и полный config сохранены;
- отдельный command channel подтверждён уникальным outbound tag;
- реальный platform DNS, UDP relay и HTTPS 204 через диагностический libbox;
- обычное Android-приложение с другим UID получает HTTPS 204 через VPN при живом диагностическом процессе;
- тот же диагностический PID проверяется до, во время и после обычного запроса;
- отмена, запрет создать TUN, гибель Binder-клиента, авария процесса и новый запуск;
- временный Xray достигает собственного задержанного HTTP fixture; его завершение и отмена не затрагивают рабочий Xray;
- после гибели диагностического владельца новый запуск не оставляет старый дочерний процесс.

HTTP fixture временного Xray доказывает владение и очистку, а не здоровье удалённого профиля. Реальный внешний HTTPS проверяется отдельно через рабочий VPN и libbox.

На этом телефоне Android сам завершил временный Xray после гибели владельца (`orphanSurvivedOwner=false`). Поэтому этот прогон **не выдаётся за прямое доказательство native orphan reaper** для случая выжившего ребёнка; соответствующая policy покрыта JVM-тестами.

Дополнительно:

- **9 PASS** карточки ошибок, отмены подготовки и сохранения профилей;
- **8 PASS** маршрутизации sing-box/Xray, include/exclude и отклонения некорректных кандидатов; все последние сетевые запросы прошли с первой попытки;
- после переключений восстановлены полный исходный config, app policy, engine, settings, profiles, selection и принятое имя.

## Автоматические проверки и сборка

- Android JVM: **51 PASS**.
- Rust safe suite: **285 PASS**, 14 ignored, 29 системных тестов исключены; последовательный запуск.
- Node helpers: **11 PASS**; синтаксис обоих device runners проверен.
- Frontend build и Android Rust release build успешно выполнены; свежая библиотека включена в APK.
- Debug APK, release Kotlin и release manifest собраны. Экспериментальные компоненты отсутствуют в release manifest.
- Targeted Rust formatting и git diff --check пройдены.

Первый параллельный Rust-прогон имел 18 отказов, включая profile_source_busy из общей блокировки каталога. Последовательный полный safe-прогон прошёл. Изменения синхронизации этих тестов находятся вне данного исправления.

<details>
<summary>Имена отказавших тестов параллельного прогона</summary>

- commands::ready_preflight_tests::rejected_profile_preserves_the_running_engine
- subscriptions::store::tests::replace_all_atomically_replaces_and_survives_reload
- subscriptions::store::tests::storage_round_trip_preserves_private_bundle_data
- subscriptions::tests::blank_provider_title_keeps_generic_subscription_name
- subscriptions::tests::custom_subscription_name_wins_over_provider_title
- subscriptions::tests::failed_refresh_keeps_last_valid_bundle_and_selection
- subscriptions::tests::failed_refresh_preserves_existing_subscription_name
- subscriptions::tests::migrate_legacy_generic_name_adopts_provider_title
- subscriptions::tests::mixed_bundle_refresh_rejects_the_entire_candidate
- subscriptions::tests::opaque_link_refs_resolve_and_reject_invalid_selection
- subscriptions::tests::provider_title_replaces_generic_subscription_name
- subscriptions::tests::refresh_falls_back_to_first_child_when_selected_position_is_removed
- subscriptions::tests::refresh_keeps_positional_selection_when_credentials_change
- subscriptions::tests::refresh_keeps_selection_at_the_same_position_when_children_reorder
- subscriptions::tests::refresh_of_persisted_generic_name_adopts_provider_title
- subscriptions::tests::refresh_without_provider_title_preserves_persisted_generic_name
- subscriptions::tests::snapshot_never_serializes_or_debug_formats_link_credentials
- subscriptions::tests::stored_encoded_provider_title_is_migrated_on_refresh

</details>

## Воспроизведение

Только на явно разрешённом устройстве, с работающим VPN и установленным test-only helper:

```text
node scripts/android-isolation-check.mjs --adb <adb> --serial <device> --output <private-report.json>
node scripts/android-xray-isolation-check.mjs --adb <adb> --serial <device> --output <private-report.json>
```

Первый runner проверяет libbox. Второй запускает локальный HTTP fixture и собственную ADB reverse mapping, проверяя настоящий упакованный Xray/LatencyTester. Пользовательские конфигурации они не меняют. При preserved:false дальнейшие эксперименты запрещены до восстановления исходного полного config. Переключения рабочего ядра выполнялись отдельным приватным runner с обязательным восстановлением.

Копии и отчёты устройства остаются в игнорируемом каталоге .superpowers. В Git не записываются пользовательские конфигурации, ключи, тела ответов или адреса внешнего выхода.

## Ревью и состояние телефона

Независимое read-only ревью cfc1b31..19aab6e: новых Critical, Important или Minor замечаний нет. Это оценка текущего checkpoint; перечисленные ниже ограничения общей D3 остаются.

После финальной матрицы вспомогательный APK удалён. ADB forward/reverse mappings пусты. Повторная приватная сверка подтвердила running sing-box и совпадение полной конфигурации, профилей, настроек, выбранного сервера и принятого имени. Исправленная debug-сборка Cloakwire оставлена установленной.

## Границы результата

- Матрица подтверждена на одном Android 16 устройстве. Older Android, always-on/lockdown, физическая смена сети и сон не проверены; общая D3-матрица ещё не завершена.
- Продуктовые profile ownership/snapshot, Stop/network-loss coordination и Hysteria2/TUIC остаются следующей частью D3.
- Minor предыдущего ревью остаётся: config/lease может сохраняться, когда записанные владелец и ребёнок уже отсутствуют. Нужна отдельная очистка с различением отсутствующего и нечитаемого процесса.
- Автовосстановление и новая UI-проверка не включены. Принятое поведение при принудительном закрытии задачи сохранено. Push, merge и release не выполнялись.
