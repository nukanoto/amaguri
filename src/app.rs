use anyhow::{Result, anyhow};
use async_native_tls::TlsConnector;
use futures::TryStreamExt;
use mailparse::{MailHeaderMap, parse_mail};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::time::{Duration, sleep};

#[derive(Debug, Clone)]
pub struct App {
    config: Config,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_domain: String,
    pub imap_username: String,
    pub imap_password: String,
    pub discord_webhook_url: String,
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

pub fn extract_field(raw: &str, field: &str) -> Result<String> {
    let (headers, _) = mailparse::parse_headers(raw.as_bytes())?;
    for h in headers {
        if h.get_key().eq_ignore_ascii_case(field) {
            return Ok(h.get_value());
        }
    }
    Ok(String::new())
}

impl App {
    pub fn new(config: Config) -> Self {
        App { config }
    }

    pub async fn run(&self) -> Result<()> {
        loop {
            if let Err(e) = self.check_imap().await {
                eprintln!("Error during IMAP check: {:?}", e);
                return Err(e);
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn check_imap(&self) -> anyhow::Result<()> {
        let tls = TlsConnector::new();
        let tcp_stream =
            TcpStream::connect((&*self.config.imap_host, self.config.imap_port)).await?;
        let tls_stream = tls.connect(&self.config.imap_domain, tcp_stream).await?;

        let client = async_imap::Client::new(tls_stream);

        let mut imap_session = client
            .login(
                self.config.imap_username.clone(),
                self.config.imap_password.clone(),
            )
            .await
            .map_err(|e| e.0)?;

        imap_session.select("INBOX").await?;
        let mut all_uids: Vec<u32> = imap_session
            .uid_search("UNSEEN")
            .await?
            .into_iter()
            .collect();
        all_uids.sort();
        let last_uids = if all_uids.len() > 20 {
            all_uids[all_uids.len() - 20..].to_vec()
        } else {
            all_uids
        };
        let all_reversed: Vec<u32> = last_uids.into_iter().rev().collect();
        for uid in all_reversed {
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

                self.send_discord_notification(&from, &subject, notification_body)
                    .await?;
            }
        }

        imap_session.logout().await?;

        Ok(())
    }

    pub async fn send_discord_notification(
        &self,
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
        let res = client
            .post(&self.config.discord_webhook_url)
            .json(&req_body)
            .send()
            .await?;

        if !res.status().is_success() {
            return Err(anyhow!(
                "Failed to send Discord notification: {}",
                res.status()
            ));
        }

        Ok(())
    }
}
