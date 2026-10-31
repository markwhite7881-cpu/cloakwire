# Profiles and interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обновлять ручные профили без потери выбора и показывать точное состояние подключения и маршрутизации на всех платформах.

**Architecture:** Данные v2 получают локальный id и revision; генератор продолжает получать прежние Outbound. Новые UI-компоненты потребляют диагностику части A. Существующие Android режимы и desktop rules сохраняются.

**Tech Stack:** React 18/TypeScript, Rust/Tauri 2, Kotlin/Android; Vitest, Cargo/JVM tests и Playwright.

**Spec:** ../specs/2026-10-31-connection-reliability-and-ux-design.md

**Status:** план для проверки; реализация не начата. Порядок зависимостей задаёт 2026-10-31-reliability-and-ux-roadmap.md.

## Global Constraints

См. обязательные ограничения спецификации. Сохранять active_run_id/ready_check_epoch и PendingProfileStarts; stale results не меняют новый run. Probe не меняет TUN, proxy, routing, selection или сохранённый профиль. Использовать фактическое ядро профиля. Сохранять DNS/GeoIP/provider rules и текущую политику защиты при обрыве. Новые сообщения RU/EN/zh-CN; никакой телеметрии или секретов в отчётах. Не обновлять ядра и минимальные ОС. Системные тесты — только на выделенных устройствах.

## Review Focus

1. Stop/смена сервера во время probe/recovery: результат старой операции не меняет подключение (D1, D2, C1–C3).
2. Одинаковые имена и адреса, разные пользователи/подписки: нет случайного обновления соседней записи (B1, B2).
3. Активный TUN/другая физическая сеть: probe не закольцовывается и не даёт успех через чужой профиль (D2, D3).
4. Локальный bypass и provider/custom rules: интерфейс не обещает маршрутизацию, которой фактически нет (B3, C4).
5. Ошибка хранилища, migration/downgrade, погибшая Activity: данные и активная сессия восстанавливаются без ложного успеха (B1, B2, D3, B4, C3, C4).

### B1. Безопасная идентичность ручных профилей и миграция

**Files:** изменить src/lib/{manualProfiles.ts,lastServer.ts,connectionProfiles.ts,profileSelection.ts}, src/mobile/lib/{lastServer.ts,serverGrouping.ts}, src/App.tsx, src/mobile/MobileApp.tsx; создать src/lib/manualProfileStore.ts и .test.ts, добавить migration/selection tests в существующие файлы.
**Dependency:** D0 baseline, D1 ProfileRef contract.
**Interfaces:** ManualProfileRecord={id:string,revision:number,outbound:Outbound}; ManualProfileEnvelope={version:2,records:ManualProfileRecord[],legacyMirrorFingerprint:string|null,legacyMirrorStatus:"ready"|"pending"}.
loadManualProfileStore(storage): LoadResult; saveManualProfileStore(storage,records): SaveResult; toGeneratorOutbounds(records): Outbound[]. LoadResult явно различает ready, legacy_conflict, corrupt; SaveResult различает saved, mirror_failed, failed.
**Persistence:** новый key singbox-client.manual-profiles.v2, существующий v1 сохранён как mirror. lastServer manual:<id>, legacy tag переводится только при единственном совпадении. Subscription index-N остаются позиционными; не выдавать их за постоянную identity сервера.

- [ ] Tests migration_is_idempotent_and_keeps_v1; failed_v2_write_retains_original; duplicate_tags_do_not_guess_selection; outbound_payload_has_no_ui_metadata; legacy_edit_after_downgrade_requires_reconciliation; mirror_failure_is_visible; renamed_profile_keeps_id_and_selection.
- [ ] npm test -- src/lib/manualProfileStore.test.ts src/lib/lastServer.test.ts; подтвердить FAIL для новой миграции.
- [ ] Реализовать атомарную запись v2 envelope и совместимый v1 mirror, marker/fingerprint по спецификации; не считать старый backup текущими данными.
- [ ] При legacy conflict сохранить обе коллекции, показать выбор источника/объединения без секретов; автоподключение до решения не допускается. Unique exact payload сохраняет id; неоднозначный матч требует выбора.
- [ ] Перевести manual selection и React keys на id, но параметры генератора/outbound tag оставить прежними. Native accepted session возвращает manual id; Auto получает snapshot id.
- [ ] npm test и npm run build; проверить migration на копии синтетического 1.4.9 storage и downgrade→edit→upgrade. Коммит feat: preserve profile identity across updates.

### B2. Сравнение при повторном импорте

**Files:** создать src/lib/profileImport.ts и .test.ts, src/components/ProfileImportDialog.tsx и .test.tsx; mobile использует существующий Sheet с тем же model. Изменить App.tsx, MobileApp.tsx, mobile/components/AddSubscriptionSheet.tsx, manualProfileStore.ts; RU/EN/zh-CN locale files.
**Interfaces:** planProfileImport(existing:ManualProfileRecord[],incoming:Outbound[]): ImportPlan; ImportCandidate={record_id,expected_revision,changed_fields:string[],exact_duplicate:boolean}; applyProfileImport(plan,decisions,current): ImportApplyResult.
Decisions: update(record_id,expected_revision), add_separately, skip. Поля secret-bearing сравниваются локально без вывода значений. Subscription records не входят в manual candidates.

- [ ] Tests same_endpoint_different_credentials_requires_choice; exact_duplicate_skipped; multiple_candidates_never_auto_replace; update_preserves_id_name_position_and_rules; stale_dialog_revision_rejected; active_snapshot_unchanged_until_reconnect; subscription_not_overwritten; storage_failure_keeps_dialog_open.
- [ ] npm test -- src/lib/profileImport.test.ts; увидеть FAIL, реализовать normalize endpoint/protocol только для кандидатов, не для идентификации человека.
- [ ] В диалоге показать безопасные категории «данные пользователя», «ключ», «сервер/порт», «транспорт», «TLS». Предлагаемая update-операция сохраняет пользовательский tag; отдельное добавление создаёт новый id и непересекающийся generator tag, не переписывая существующие ссылки правил.
- [ ] Подключить одинаковый flow для desktop paste, mobile paste/import и массового списка. Отмена не меняет storage. Частично некорректный импорт показывает failures отдельно, уже корректные кандидаты не теряет.
- [ ] После update сбросить health этой revision; для активного профиля поднять существующий reconnect notice. Кнопка refresh подписки обновляет только backend-owned subscription.
- [ ] Frontend suites/build + браузерные import scenarios в B5; коммит feat: update existing profiles during import.

### B3. Простые режимы без разрушения advanced routing

**Files:** создать src/lib/routingMode.ts и .test.ts; изменить src/lib/processSelection.ts и .test.ts, src/components/routing/RoutingTab.tsx, src/mobile/screens/RoutingScreen.tsx, src/lib/types.ts и defaults.ts только additive; tests config/mod.rs/config/ready.rs при генерации изменённых списков; RU/EN/zh-CN.
**Interfaces:** describeRoutingMode(settings,platform,engine): RoutingModeSummary; planRoutingModeChange(settings,mode:"all"|"include"|"exclude"): {next,conflicts,summary}; apply только после пользовательского выбора.
RoutingModeSummary={mode:"all"|"include"|"exclude"|"custom",hasAdditionalRules:boolean,available:boolean,reason:string|null}. Inactive draft lists хранятся как UI prefs отдельно от исполняемых RoutingOptions.

- [ ] Tests merely_opening_tab_does_not_mutate; custom_final_and_overlapping_lists_remain_custom; include_empty_is_rejected; mode_switch_preserves_dns_rulesets_custom_rules; dormant_list_never_executes; returning_to_mode_restores_draft_list; desktop_xray_warns_instead_of_claiming_capture.
- [ ] npm test -- src/lib/routingMode.test.ts src/lib/processSelection.test.ts; ожидаемый FAIL.
- [ ] Для desktop простые all/include/exclude переводятся в прежние process rules/final; обе заполненные конфликтующие группы и нестандартный final отображаются custom. Не проводить silent normalization старого storage.
- [ ] Для Android использовать существующие tun_app_mode/tun_app_list; не переносить desktop process_name в package list. Сохранить include validation из native preflight.
- [ ] При конфликте показать, какой активный простой список отключится; значения сохранить в drafts. Custom/provider rules остаются; summary честно сообщает дополнительные правила и область базовой политики.
- [ ] Rust route fixture checks + JVM policy tests + frontend suite/build; коммит feat: clarify application routing modes.

### B4. Статусы, серверы и действия ошибок

**Files:** создать src/lib/connectionPresentation.ts и .test.ts, src/components/ConnectionStatus.tsx и ServerHealthBadge.tsx; изменить HomeTab.tsx, ServersTab.tsx, ProfileCard.tsx, ConnectionErrorCard.tsx и соответствующие tests; mobile screens HomeScreen.tsx/ServersScreen.tsx, useVpnConnection.ts, App.tsx/MobileApp.tsx, lib/vpn.ts; locale files.
**Interfaces:** presentConnection(lifecycle,acceptedSession,health,issue): ConnectionPresentation; badgeForProfile(ref,revision,health,now): HealthBadge; action handler dispatches enum retry_probe|reconnect|refresh_subscription|choose_server to owner-specific existing functions.
**Dependency:** D4/D5, B1/B2; routing summary consumes B3.

- [ ] Tests running_without_check_is_not_verified; selected_candidate_does_not_relabel_connected; rejected_candidate_keeps_old_connected_badge; old_revision_and_expired_health_stale; removed_source_keeps_active_snapshot_label; auto_badge_tracks_effective_member; cancelled_probe_not_error.
- [ ] npm test -- src/lib/connectionPresentation.test.ts; убедиться в FAIL.
- [ ] Ввести состояния из спецификации без замены native Status/VpnState. Пока backend не отдаёт health, fallback — «VPN запущен», а не подтверждённый доступ.
- [ ] Разделить выбранный/подключённый сервер, источник, checked_at и TCP/реальную задержку. Refresh изменившейся позиционной subscription entry не переносит старый результат на новый server.
- [ ] Расширить карточку существующих ошибок действием по safe code. Tests manual_profile_has_no_refresh; action_targets_original_ref_revision; repeated_click_single_request; stale_action_requests_current_selection.
- [ ] Состояние после Activity recreation берётся из native snapshot; UI event listener не владеет lifetime probes/recovery.
- [ ] npm test/build, native DTO tests; коммит feat: show connection health and actionable errors.

### B5. Читаемость и визуальная проверка

**Files:** изменить src/index.css, src/components/{Button.tsx,Card.tsx,Badge.tsx,StatusPill.tsx} и затронутые экраны, mobile/components/{SectionCard.tsx,Sheet.tsx,Switch.tsx}; создать playwright.config.ts, e2e/{connection-ui.spec.ts,profile-import.spec.ts,routing-modes.spec.ts,fixtures.ts}; package.json для согласованного test:ui.
**Dependency:** B2–B4. Не тестировать заново каждое косметическое CSS-значение unit-тестами; проверять пользовательские действия/доступность/обрезание.

- [ ] Создать UI fixtures без Tauri/network/credentials: stopped/checking/healthy/degraded/recovering, длинные имена, 100 серверов, конфликт импорта, custom routing.
- [ ] Сначала playwright tests для переключения selected/connected, Import dialog keyboard/Cancel, error action availability и overflow на 1040x680/360px; увидеть ожидаемые проблемы.
- [ ] Сохранить темы и навигацию. Применить спецификацию типографики (14px информационный текст, 12px минимум technical), touch area ≥44px, focus/reduced-motion, текст+цвет.
- [ ] Проверить system/light/dark/OLED × 5 accents; RU/EN/zh-CN. Desktop scale 100/125/150/200%; mobile widths 360/390/430 и крупный текст. Полная комбинация ключевых screens + репрезентативные остальные, перечень результатов записать.
- [ ] Настроить Playwright через имеющийся пакет playwright; при необходимости отдельный @playwright/test добавить той же закреплённой версии с обоснованием, без попутного обновления toolchain.
- [ ] npm run test:ui; npm test; npm run build. Снять скриншоты и проверить визуально. Затем OS smoke WebView2, WKWebView, Android WebView; браузерный PASS не подменяет их.
- [ ] Коммит style: improve connection screen readability across platforms.

## Выход из части B

Обновление профилей, видимые состояния/ошибки и режимы работают без смены поведения существующей активной сессии. Старые данные читаются, откат не теряет последующие правки. Новый UI не заявляет, что Xray desktop умеет process routing или что успешный отдельный probe подтверждает весь TUN.
