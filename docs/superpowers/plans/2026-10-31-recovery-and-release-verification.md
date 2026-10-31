# Recovery and release verification Implementation Plan

**Уточнение пользователя, 2026-10-31:** отключение VPN при принудительном закрытии/пересоздании Android-задачи — ожидаемое поведение. Сохранить его; не блокировать дальнейший план и не восстанавливать соединение вопреки этому намерению. Обычное восстановление экрана/подписки на состояние проверяется отдельно.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Восстанавливать выбранное соединение после сна/смены сети и выпускать изменения только после системной матрицы.

**Architecture:** Один native coordinator реагирует на события ОС, проверяет активную сессию и использует существующий управляемый запуск. Новая настройка выключена по умолчанию; UI и диагностика из A/B уже доступны.

**Tech Stack:** React 18/TypeScript, Rust/Tauri 2, Kotlin/Android; Vitest, Cargo/JVM tests и Playwright.

**Spec:** ../specs/2026-10-31-connection-reliability-and-ux-design.md

**Status:** реализация начата. C1–C5 не завершены; recovery не включён. Доступны baseline и безопасные тесты. Системная/устройственная и пакетная приёмка остаётся впереди. [Результаты](../../testing/implementation-stage-2026-10-31.md).

## Global Constraints

См. обязательные ограничения спецификации. Сохранять active_run_id/ready_check_epoch и PendingProfileStarts; stale results не меняют новый run. Probe не меняет TUN, proxy, routing, selection или сохранённый профиль. Использовать фактическое ядро профиля. Сохранять DNS/GeoIP/provider rules и текущую политику защиты при обрыве. Новые сообщения RU/EN/zh-CN; никакой телеметрии или секретов в отчётах. Не обновлять ядра и минимальные ОС. Системные тесты — только на выделенных устройствах.

## Review Focus

1. Stop/смена сервера во время probe/recovery: результат старой операции не меняет подключение (D1, D2, C1–C3).
2. Одинаковые имена и адреса, разные пользователи/подписки: нет случайного обновления соседней записи (B1, B2).
3. Активный TUN/другая физическая сеть: probe не закольцовывается и не даёт успех через чужой профиль (D2, D3).
4. Локальный bypass и provider/custom rules: интерфейс не обещает маршрутизацию, которой фактически нет (B3, C4).
5. Ошибка хранилища, migration/downgrade, погибшая Activity: данные и активная сессия восстанавливаются без ложного успеха (B1, B2, D3, B4, C3, C4).

### C1. Политика восстановления и пользовательское намерение

**Files:** создать src-tauri/src/recovery/{mod.rs,policy.rs}, Kotlin vpn/RecoveryPolicy.kt и test, src/lib/recoverySettings.ts и .test.ts; изменить settings DTO/defaults и desktop/mobile Settings screens, locale files.
**Interfaces:** RecoveryInput={intent:"connected"|"disconnected",session:SessionIdentity,event,health,evidence,now}; RecoveryDecision=Wait|ProbeActive|ProbeCandidate|Reconnect(snapshot_id)|GiveUp(issue)|Cancel.
Native coordinator хранит desired_session snapshot и generation. Browser не запускает retry timers.
**Constants:** enabled=false для legacy/default; debounce 2000ms; retry delays [2000,5000,15000]ms; max attempts=3; stable reset=60000ms; only one transition.

- [ ] Tests disabled_preserves_current_behavior; manual_stop_cancels_all; wake_does_not_connect_if_user_stopped; burst_events_coalesce; new_network_does_not_reset_retry_budget; authentication_failure_does_not_retry; candidate_probe_success_does_not_mark_active_session_recovered.
- [ ] Rust cargo test recovery:: и JVM RecoveryPolicyTest должны сначала FAIL.
- [ ] Определить reconnect evidence: dead accepted engine либо два active_session failures для current network при доступной physical network и successful selected_profile probe; неопределённый health/test-site failure не достаточен.
- [ ] Реализовать policy как чистые переходы с clock argument и тестировать без ожидания реальных 2/5/15 секунд.
- [ ] User Stop/permission revoke/new connect меняют epoch до ожидания любых I/O; действие старого epoch не имеет права вызвать start/reset.
- [ ] Native/JVM/frontend suites; коммит feat: define bounded connection recovery policy.

### C2. События Windows/macOS и desktop coordinator

**Files:** создать src-tauri/src/recovery/{coordinator.rs,windows.rs,macos.rs}; изменить lib.rs, process.rs, commands.rs и Cargo.toml только необходимые platform bindings; tests в новых modules.
**Interfaces:** NativeNetworkEvent={kind:"wake"|"network_changed"|"network_lost",generation:string}; subscribe_network_events(callback)->SubscriptionGuard; RecoveryCoordinator::on_event(event) и cancel(intent_epoch).
**Dependency:** C1, D2/D4/D5; основной путь start/stop не копируется в recovery.

- [ ] Tests stale_wake_cannot_restart_new_profile; healthy_active_session_no_restart; disappeared_interface_waits; stop_during_backoff_has_no_spawn; recovery_uses_accepted_snapshot_not_unsaved_ui_settings; failures_do_not_switch_to_another_server.
- [ ] Подключить Windows resume/power + physical route changes и macOS wake/path notifications; существующий native event bridge остаётся источником, setInterval в React не заменяет эти события.
- [ ] После debounce запустить active probe. Если подтверждён нужный reconnect, получить существующий lifecycle gate и повторно проверить epoch непосредственно перед start.
- [ ] Не открывать новые окна UAC/повторные циклы admin approval из background retry; если требуются права — остановить recovery и показать действие пользователю.
- [ ] Сохранить текущую фактическую cleanup policy: Windows firewall isolation не включать, macOS не объявлять постоянный killswitch только по флагу. Не обещать блокировку утечек, которой нет в baseline.
- [ ] В выделенной Windows VM/macOS: сон→wake, Ethernet↔Wi-Fi, сеть отсутствует/вернулась, 3 failures, Stop и выбор нового профиля в каждой фазе. Зафиксировать routes/proxy/processes до/после.
- [ ] Native suites + core matrix; коммит feat: recover desktop sessions after network changes.

### C3. Android coordinator и существующие restart paths

**Files:** создать vpn/RecoveryCoordinator.kt и tests; изменить CloakwireVpnService.kt, CloakwirePlatform.kt, XrayEngine.kt, VpnEvents.kt, VpnPlugin.kt; instrumentation tests в src/androidTest.
**Interfaces:** coordinator владеет session generation, captured accepted snapshot и policy C1; network events исходят из non-VPN Network callbacks. Engine-death recovery и network recovery используют один budget/owner.
**Dependency:** D3 scoped process cleanup, C1, D5 active identity.

- [ ] Tests old_engine_death_thread_cannot_restart_new_session; probe_and_session_children_not_killed_cross_owner; vpn_network_ignored; recreation_reads_native_state; user_stop_releases_pending_work; network_identity_replaced_not_reused; stopped_service_not_restarted_by_callback.
- [ ] Получить FAIL; заменить sessionActive-only guard на epoch/snapshot; связать существующий ограниченный onEngineDied restart с coordinator.
- [ ] Смена сети сначала даёт libbox текущий physical interface и шанс восстановиться; активный успешный probe отменяет лишний restart.
- [ ] При сохранённом Android blackhole/TUN новый recovery не вызывает обычный teardownComponents и не открывает прямой трафик до готовности замены. Учитывать фактические kill_switch/block_ipv6 настройки без изменения defaults.
- [ ] Реальное устройство: Wi-Fi↔mobile, screen off/on, network lost, active VPN include/exclude, always-on/lockdown allowed/unavailable. Неподдержанную проверку показывать явно, не помечать healthy.
- [ ] JVM tests, assembleDebug, instrumentation/device report; коммит feat: recover Android sessions with one lifecycle owner.

### C4. Общая проверка настоящих ядер и готовых пакетов

**Files:** дополнить scripts/test-connection-matrix.mjs и scripts/connection-matrix/*; создать docs/testing/connection-release-matrix.md, .github/workflows/connection-regression.yml; изменить package.json/test scripts; scripts/build-all-platforms.ps1/release-workflow.psm1 только для вызова нового verifier и записи результатов.
**Interfaces:** report schema из D0; проверяем commit+platform+core artifact SHA256; release gate не принимает report другого commit/binary. Runtime fixtures создаются заново с временными credentials.
**Dependency:** A/B/C1–C3; D0 runner уже существует.

- [ ] Tests report_for_different_core_rejected; missing_platform_not_pass; skipped_system_suite_not_pass; real_fixture_invalid_credentials_fails; unsigned/test_artifact_cannot_be_published.
- [ ] В CI быстрые suites на PR/main; реальные desktop cores проверять в Windows/macOS jobs, Android JVM на обычном runner, device tests на доступном эмуляторе/выделенном устройстве. Не назначать отсутствующие self-hosted runners как будто они есть: блокирующие device cases фиксировать в ручном pre-release checklist.
- [ ] Проверить из готовых пакетов те же ядра/ресурсы и версии, которые тестировались; после установки в VM пройти connect/stop/reconnect. Не подменять packaged smoke запуском dev binary.
- [ ] Системный routing test: два отдельных probe-приложения A/B и контролируемый destination; подтвердить фактический egress для all/include/exclude, одновременно с GeoIP/provider/custom rules. Для Xray desktop записать unsupported per-process, проверить system proxy и предупреждение.
- [ ] Матрица профилей: manual VLESS/VMess/Trojan/SS/Hysteria2/TUIC по поддержке sing-box; subscription links; ready sing-box и ready Xray, nested selectors/detours, provider DNS/rulesets, implicit resolver, локальная DNS-ошибка, неправильный Reality key.
- [ ] Проверить неверный candidate при живой сессии, Stop во время preflight/probe/recovery, смену выбранного сервера при старом active, refresh/reorder подписки во время probe, двойные callbacks, истечение health.
- [ ] Migration: 1.4.9→new, restart, controlled downgrade→edit→upgrade, duplicate tags, quota/storage failure, восстановление выбранного сервера и правил.
- [ ] Коммит test: gate releases on real connection scenarios.

### C5. Приёмка и подготовка выпуска

**Files:** docs/testing/connection-release-matrix.md; CHANGELOG.md; README.md/README.en.md/README.ru.md/README.zh-CN.md; версия через scripts/release-version.mjs, существующие release scripts.
**Interfaces:** release evidence manifest содержит утверждённый commit, команды, результаты, исключения, ссылки на build artifacts. Опубликованные 1.4.9 assets не заменяются.

- [ ] Проверить все requirements спецификации по task/case IDs; любой FAIL устраняется отдельно, без изменения baseline expectation под ошибку.
- [ ] npm test; npm run build; npm run test:ui; полные Rust/JVM suites в выделенном окружении; real-core/system/device matrix; npm run release:test; git diff --check.
- [ ] Собрать тестовые пакеты на Windows/macOS/Android, вручную пройти реальные сценарии и визуальную матрицу B5. Нет устройства/сценария — явно не проверено, не зелёный релиз.
- [ ] Получить независимый whole-branch review по отмене/ownership, миграции, сетевым policy, secret handling и UI identity; исправления подтверждать целевыми тестами.
- [ ] После решения о выпуске согласовать новую версию; npm run release:version -- set <version>; синхронизировать UI/Android metadata и все README.
- [ ] Существующий build/sign/verify pipeline: 7 пакетов, 7 signatures, manifest/catalogs = 18 assets. Никаких секретов в repo, fixtures или artifact report.
- [ ] Подготовить reviewable release draft и результаты. Публикация только по отдельному распоряжению пользователя о новом выпуске; текущее поручение не означает автоматический релиз.

## Откат и контроль места

Каждый task — отдельный проверенный коммит. Diagnostics, UI import/routing и recovery отделены; recovery отключается настройкой и может быть откатан без отката UI. Для data rollback использовать актуальный legacy mirror и reconciliation из B1, не старую резервную копию.

Build cache один на совместимый target/toolchain; хранить отчёты и финальные тестовые пакеты, не плодить архивы всех промежуточных source/target. Удаление пользовательских release/cache folders не входит в эту работу. Сначала показывать проверяемый список disposable paths, если очистка понадобится.
