use std::env;

use anyhow::{Result, anyhow};
use async_imap::{extensions::idle::IdleResponse, types::Uid};
use async_native_tls::TlsConnector;
use futures::TryStreamExt;
use mailparse::{MailHeaderMap, parse_mail};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;

#[derive(Debug)]
struct Config {
    imap_host: String,
    imap_port: u16,
    imap_domain: String,
    imap_username: String,
    imap_password: String,
    discord_webhook_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config {
        imap_host: env::var("IMAP_HOST").expect("IMAP_HOST must be set"),
        imap_port: env::var("IMAP_PORT")
            .unwrap_or_default()
            .parse::<u16>()
            .unwrap_or(993),
        imap_domain: env::var("IMAP_DOMAIN").expect("IMAP_DOMAIN must be set"),
        imap_username: env::var("IMAP_USERNAME").expect("IMAP_USERNAME must be set"),
        imap_password: env::var("IMAP_PASSWORD").expect("IMAP_PASSWORD must be set"),
        discord_webhook_url: env::var("DISCORD_WEBHOOK_URL")
            .expect("DISCORD_WEBHOOK_URL must be set"),
    };

    println!("Configuration: {:?}", config);

    let imap_addr = (config.imap_host.clone(), config.imap_port);
    let tcp_stream = TcpStream::connect(imap_addr).await?;
    let tls = TlsConnector::new();
    let tls_stream = tls.connect(&config.imap_domain, tcp_stream).await?;

    let client = async_imap::Client::new(tls_stream);

    // the client we have here is unauthenticated.
    // to do anything useful with the e-mails, we need to log in
    let mut imap_session = client
        .login(config.imap_username, config.imap_password)
        .await
        .map_err(|(err, _client)| err)?;

    imap_session.select("INBOX").await?;
    let mut last_seen_uid = imap_session.uid_search("1:*").await?.into_iter().max();

    loop {
        let mut idle = imap_session.idle();
        idle.init().await?;

        let (idle_wait, interrupt) = idle.wait();
        let idle_result = idle_wait.await?;
        imap_session = idle.done().await?;

        if let IdleResponse::NewData(_) = idle_result {
            let search_query = match last_seen_uid {
                Some(uid) => format!("{}:*", uid + 1),
                None => "1:*".to_string(),
            };

            let mut new_uids: Vec<Uid> = imap_session
                .uid_search(&search_query)
                .await?
                .into_iter()
                .filter(|uid| last_seen_uid.map_or(true, |last| *uid > last))
                .collect();

            if new_uids.is_empty() {
                continue;
            }

            new_uids.sort_unstable();

            for uid in new_uids {
                let mut fetches = imap_session
                    .uid_fetch(uid.to_string(), "(UID RFC822)")
                    .await?;

                while let Some(fetch) = fetches.try_next().await? {
                    let body_bytes = match fetch.body() {
                        Some(bytes) => bytes,
                        None => {
                            eprintln!("Failed to fetch body for UID {}.", uid);
                            continue;
                        }
                    };

                    let parsed = parse_mail(body_bytes)?;
                    let plain_body = if parsed.subparts.is_empty() {
                        if parsed.ctype.mimetype != "text/plain" {
                            None
                        } else {
                            parsed.get_body().ok()
                        }
                    } else {
                        parsed
                            .subparts
                            .iter()
                            .find(|x| x.ctype.mimetype == "text/plain")
                            .and_then(|x| x.get_body().ok())
                    };

                    let from = parsed
                        .get_headers()
                        .get_first_value("From")
                        .unwrap_or_else(|| "Unknown sender".to_string());

                    let subject = parsed
                        .get_headers()
                        .get_first_value("Subject")
                        .unwrap_or_else(|| "No subject".to_string());

                    let plain_body_text = plain_body.as_deref();
                    let body_text = plain_body_text.unwrap_or("No body");

                    println!("=== New Email ===");
                    println!("UID: {}", uid);
                    println!("From: {}", from);
                    println!("Subject: {}", subject);
                    println!("Body:\n{}\n", body_text);

                    let notification_body = plain_body_text.unwrap_or("_No Content_");

                    send_discord_notification(
                        &config.discord_webhook_url,
                        &from,
                        &subject,
                        notification_body,
                    )
                    .await?;
                }

                last_seen_uid = Some(uid);
            }
        }

        drop(interrupt);
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct WebhookBody {
    username: Option<String>,
    avatar_url: Option<String>,
    content: Option<String>,
    embeds: Option<Vec<Embed>>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Embed {
    title: String,
    url: String,
    description: String,
    author: Option<EmbedAuthor>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct EmbedAuthor {
    name: String,
    url: Option<String>,
    icon_url: Option<String>,
}

async fn send_discord_notification(
    webhook_url: &str,
    from: &str,
    subject: &str,
    content: &str,
) -> Result<()> {
    let limited_content = truncate_utf8_to_char_limit(content, 1500);

    let req_body = WebhookBody {
        username: Some(from.to_string()),
        avatar_url: None,
        content: None,
        embeds: Some(vec![Embed {
            title: subject.to_string(),
            url: "https://www.stb.tsukuba.ac.jp/webmail".to_string(),
            author: Some(EmbedAuthor {
                name: from.to_string(),
                url: None,
                icon_url: None,
            }),
            description: limited_content,
        }]),
    };

    let client = reqwest::Client::new();
    let res = client.post(webhook_url).json(&req_body).send().await?;

    if !res.status().is_success() {
        return Err(anyhow!(
            "Failed to send Discord notification: {}",
            res.status()
        ));
    }

    Ok(())
}

fn truncate_utf8_to_char_limit(source: &str, max_chars: usize) -> String {
    let mut iter = source.char_indices();
    let mut count = 0;

    while let Some((idx, _)) = iter.next() {
        if count == max_chars {
            return source[..idx].to_string();
        }
        count += 1;
    }

    source.to_string()
}
