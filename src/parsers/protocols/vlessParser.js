import { parseServerInfo, parseUrlParams, createTlsConfig, createTransportConfig, parseBool, parseArray } from '../../utils.js';

export function parseVless(url) {
    const { addressPart, params, name } = parseUrlParams(url);
    const [uuid, serverInfo] = addressPart.split('@');
    const { host, port } = parseServerInfo(serverInfo);

    const tls = createTlsConfig(params);
    if (tls.reality) {
        tls.utls = {
            enabled: true,
            fingerprint: 'chrome'
        };
    }
    const alpn = parseArray(params.alpn);
    if (alpn) {
        tls.alpn = alpn;
    }
    const transport = params.type !== 'tcp' ? createTransportConfig(params) : undefined;
    // Share-link extras used by Surge; sing-box strips unknown keys later
    if (transport?.type === 'grpc') {
        if (params.authority) {
            transport.authority = params.authority;
        }
        if (params.mode) {
            transport.mode = params.mode;
        }
    }

    // `udp` is a Clash-only flag; ClashConfigBuilder reads it, SingboxConfigBuilder strips it.
    const udp = params.udp !== undefined ? parseBool(params.udp) : undefined;

    return {
        type: 'vless',
        tag: name,
        server: host,
        server_port: port,
        uuid: decodeURIComponent(uuid),
        tcp_fast_open: false,
        tls,
        transport,
        flow: params.flow ?? undefined,
        ...(params.encryption !== undefined ? { encryption: params.encryption } : {}),
        ...(udp !== undefined ? { udp } : {})
    };
}
