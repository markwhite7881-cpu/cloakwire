use super::targets::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn trace_requires_a_real_bounded_https_response_without_publishing_addresses() {
    let valid=b"fl=fixture\nh=www.cloudflare.com\nip=192.0.2.1\nts=123.4\nvisit_scheme=https\ntls=TLSv1.3\n";
    assert!(valid_trace(valid));
    for body in [
        b"<html>login</html>".as_slice(),
        b"h=www.cloudflare.com\nip=192.0.2.1\nts=1\nvisit_scheme=http\ntls=TLSv1.3\n",
        b"h=other.example\nip=192.0.2.1\nts=1\nvisit_scheme=https\ntls=TLSv1.3\n",
        b"h=www.cloudflare.com\nip=192.0.2.1\nts=NaN\nvisit_scheme=https\ntls=TLSv1.3\n",
        b"h=www.cloudflare.com\nip=not-an-address\nts=1\nvisit_scheme=https\ntls=TLSv1.3\n",
        b"h=www.cloudflare.com\nh=www.cloudflare.com\nip=192.0.2.1\nts=1\nvisit_scheme=https\ntls=TLSv1.3\n",
    ] {assert!(!valid_trace(body));}
    assert!(!valid_trace(&vec![b'x'; 4097]));
}

async fn proxy(responses: Vec<&'static str>) -> (u16, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut b = [0u8; 1];
                if socket.read(&mut b).await.unwrap() == 0 {
                    break;
                }
                header.push(b[0]);
                assert!(header.len() < 4096);
            }
            requests.push(String::from_utf8(header).unwrap());
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        requests
    });
    (port, task)
}

#[tokio::test]
async fn wrong_primary_status_falls_back_without_following_redirect() {
    let (port,requests)=proxy(vec![
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 19\r\nConnection: close\r\n\r\n<html>login</html>xx",
    ]).await;
    let client = ProbeClient::new(port, "ephemeral-secret").unwrap();
    let result = client
        .check(&TargetSet::fixture(
            "http://fixture.invalid/primary",
            "http://fixture.invalid/fallback",
        ))
        .await;
    assert!(result.is_err());
    let requests = requests.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("GET http://fixture.invalid/primary "));
    assert!(requests[1].starts_with("GET http://fixture.invalid/fallback "));
    assert!(requests[0]
        .to_ascii_lowercase()
        .contains("proxy-authorization: basic "));
}

#[tokio::test]
async fn primary_requires_204_and_fallback_body_is_capped() {
    let (port, requests) = proxy(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\nConnection: close\r\n\r\n",
    ])
    .await;
    assert!(ProbeClient::new(port, "secret")
        .unwrap()
        .check(&TargetSet::fixture(
            "http://fixture.invalid/a",
            "http://fixture.invalid/b"
        ))
        .await
        .is_err());
    requests.await.unwrap();
    let (port, requests) =
        proxy(vec!["HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"]).await;
    assert!(ProbeClient::new(port, "secret")
        .unwrap()
        .check(&TargetSet::fixture(
            "http://fixture.invalid/a",
            "http://fixture.invalid/b"
        ))
        .await
        .is_ok());
    assert_eq!(requests.await.unwrap().len(), 1);
}
