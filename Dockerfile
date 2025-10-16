FROM rust:1.90-alpine AS builder

RUN apk add --no-cache musl-dev libressl-dev

WORKDIR /root/app

COPY Cargo.toml .
COPY Cargo.lock .
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release

COPY --chown=root:root src src
RUN touch src/main.rs
RUN cargo build --release

FROM gcr.io/distroless/static:nonroot AS runner

USER nonroot

WORKDIR /app

COPY --from=builder /root/app/target/release/amaguri /app/amaguri

CMD ["/app/amaguri"]