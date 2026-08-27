//! Subscription service. See [service::SubscriptionService] for the
//! public surface and [model] for the data shapes.

pub mod classify;
pub mod http;
pub mod hwid;
pub mod metadata;
pub mod model;
pub mod service;
pub mod store;

pub use classify::{classify_payload, ClassifiedPayload};
pub use http::{FetchedPayload, SubscriptionHttpClient};
pub use hwid::{HwidDescription, HwidStore};
pub use metadata::parse_metadata;
pub use model::{
    ActiveChildConfig, ChildProfileSummary, DeviceHwidInfo, EngineKind, ProviderMetadata,
    SubscriptionErrorKind, SubscriptionKind, SubscriptionLinkRef, SubscriptionLinkSummary,
    SubscriptionOutbounds, SubscriptionRecord, SubscriptionSnapshot, SubscriptionSummary,
    SubscriptionUserinfo,
};
pub use service::{
    AddSubscriptionInput, LegacySubscriptionInput, RefreshSubscriptionResult, SubscriptionService,
};
pub use store::SubscriptionStore;
