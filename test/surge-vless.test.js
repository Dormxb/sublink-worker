import { describe, it, expect } from 'vitest';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';

/**
 * VLESS → Surge 转换覆盖。
 *
 * 背景：Surge 本身支持 VLESS（含 REALITY），但上游 Surge 生成器一直把 vless
 * 当作不支持的类型，只输出一行注释，导致整份配置没有任何节点。这里覆盖三种
 * 传输（REALITY/TCP、WS+TLS、gRPC+TLS）以及机场广告节点的过滤。
 */

const UUID = '11111111-2222-3333-4444-555555555555';

function build(input) {
    const builder = new SurgeConfigBuilder(input, 'minimal', [], null, 'zh-CN', null, false);
    return builder.build();
}

function proxySection(result) {
    const match = result.match(/\[Proxy\]([\s\S]*?)(?=\n\[Proxy Group\])/);
    expect(match).not.toBeNull();
    return match[1];
}

function proxyLine(result, name) {
    const line = proxySection(result)
        .split('\n')
        .find(item => item.trim().startsWith(`${name} =`));
    return line?.trim();
}

describe('Surge VLESS conversion', () => {
    it('converts VLESS + REALITY/TCP without adding tls=true', async () => {
        const result = await build(
            `vless://${UUID}@r.example.com:443?encryption=none&security=reality&type=tcp` +
            '&sni=www.apple.com&pbk=PUBKEY&sid=abcd1234&flow=xtls-rprx-vision#REALITY-TCP'
        );

        const line = proxyLine(result, 'REALITY-TCP');
        expect(line).toContain('= vless, r.example.com, 443');
        expect(line).toContain(`username=${UUID}`);
        expect(line).toContain('flow=xtls-rprx-vision');
        expect(line).toContain('sni=www.apple.com');
        expect(line).toContain('reality-public-key=PUBKEY');
        expect(line).toContain('reality-short-id=abcd1234');
        // REALITY 自带 TLS，多写 tls=true 会被 Surge 判为无效
        expect(line).not.toContain('tls=true');
    });

    it('converts VLESS + WS + TLS with host header', async () => {
        const result = await build(
            `vless://${UUID}@ws.example.com:443?encryption=none&security=tls&type=ws` +
            '&host=cdn.example.com&path=%2Fws&sni=cdn.example.com#WS-TLS'
        );

        const line = proxyLine(result, 'WS-TLS');
        expect(line).toContain('= vless, ws.example.com, 443');
        expect(line).toContain('sni=cdn.example.com');
        expect(line).toContain('ws=true');
        expect(line).toContain('ws-path=/ws');
        expect(line).toContain('ws-headers=Host:"cdn.example.com"');
        expect(line).toContain('tls=true');
    });

    it('converts VLESS + gRPC + TLS', async () => {
        const result = await build(
            `vless://${UUID}@grpc.example.com:443?encryption=none&security=tls&type=grpc` +
            '&serviceName=mygrpc&sni=grpc.example.com#GRPC-TLS'
        );

        const line = proxyLine(result, 'GRPC-TLS');
        expect(line).toContain('= vless, grpc.example.com, 443');
        expect(line).toContain('grpc=true');
        expect(line).toContain('grpc-service-name=mygrpc');
        expect(line).toContain('tls=true');
    });

    it('drops airport advert nodes from [Proxy] and proxy groups', async () => {
        const result = await build(
            [
                `vless://${UUID}@a.example.com:443?encryption=none&security=tls&type=ws&path=%2Fa#剩余流量：100GB`,
                `vless://${UUID}@b.example.com:443?encryption=none&security=tls&type=ws&path=%2Fb#套餐到期：2027-01-01`,
                `vless://${UUID}@c.example.com:443?encryption=none&security=tls&type=ws&path=%2Fc#REAL-NODE`
            ].join('\n')
        );

        expect(proxySection(result)).not.toContain('剩余流量');
        expect(proxySection(result)).not.toContain('套餐到期');
        expect(proxyLine(result, 'REAL-NODE')).toBeDefined();

        const groupMatch = result.match(/\[Proxy Group\]([\s\S]*?)(?=\n\[|$)/);
        expect(groupMatch[1]).not.toContain('剩余流量');
        expect(groupMatch[1]).toContain('REAL-NODE');
    });

    it('keeps node names free of Surge field separators', async () => {
        const result = await build(
            `vless://${UUID}@d.example.com:443?encryption=none&security=tls&type=ws&path=%2Fd#HK,01=a`
        );

        const line = proxySection(result)
            .split('\n')
            .find(item => item.includes('d.example.com'));
        expect(line).toBeDefined();
        // 逗号/等号会把整行拆坏，必须被替换
        expect(line.trim().startsWith('HK，01-a =')).toBe(true);
    });
});

describe('Surge VLESS unsupported combinations', () => {
    function groupSection(result) {
        const match = result.match(/\[Proxy Group\]([\s\S]*?)(?=\n\[|$)/);
        expect(match).not.toBeNull();
        return match[1];
    }

    it('emits a comment for WebSocket + REALITY and keeps it out of proxy groups', async () => {
        const result = await build(
            [
                `vless://${UUID}@ws.example.com:443?encryption=none&security=reality&type=ws` +
                '&pbk=PUBKEY&sid=abcd&sni=www.apple.com&path=%2Fws#WS-REALITY',
                `vless://${UUID}@ok.example.com:443?encryption=none&security=tls&type=ws&path=%2Fok#OK-WS`
            ].join('\n')
        );

        expect(proxySection(result)).toContain('# WS-REALITY - Unsupported VLESS combo: WebSocket + REALITY');
        expect(proxyLine(result, 'WS-REALITY')).toBeUndefined();
        expect(proxyLine(result, 'OK-WS')).toBeDefined();
        expect(groupSection(result)).not.toContain('WS-REALITY');
        expect(groupSection(result)).toContain('OK-WS');
    });

    it('emits a comment for gRPC without TLS and keeps it out of proxy groups', async () => {
        const result = await build(
            `vless://${UUID}@grpc.example.com:443?encryption=none&security=none&type=grpc&serviceName=mygrpc#PLAIN-GRPC`
        );

        expect(proxySection(result)).toContain('# PLAIN-GRPC - Unsupported VLESS combo: gRPC without TLS');
        expect(proxyLine(result, 'PLAIN-GRPC')).toBeUndefined();
        expect(groupSection(result)).not.toContain('PLAIN-GRPC');
    });

    it('emits a comment for XHTTP transport', async () => {
        const result = await build(
            `vless://${UUID}@x.example.com:443?encryption=none&security=tls&type=xhttp&path=%2Fx#XHTTP-NODE`
        );

        expect(proxySection(result)).toContain('# XHTTP-NODE - Unsupported VLESS transport: xhttp');
        expect(proxyLine(result, 'XHTTP-NODE')).toBeUndefined();
        expect(groupSection(result)).not.toContain('XHTTP-NODE');
    });

    it('emits a comment for HTTPUpgrade transport', async () => {
        const result = await build(
            `vless://${UUID}@h.example.com:443?encryption=none&security=tls&type=httpupgrade&path=%2Fh#HUP-NODE`
        );

        expect(proxySection(result)).toContain('# HUP-NODE - Unsupported VLESS transport: httpupgrade');
        expect(proxyLine(result, 'HUP-NODE')).toBeUndefined();
        expect(groupSection(result)).not.toContain('HUP-NODE');
    });

    it('emits a comment when encryption is not none', async () => {
        const result = await build(
            `vless://${UUID}@e.example.com:443?encryption=mlkem768x25519plus&security=tls&type=tcp#ENC-NODE`
        );

        expect(proxySection(result)).toContain('# ENC-NODE - Unsupported VLESS encryption: mlkem768x25519plus');
        expect(proxyLine(result, 'ENC-NODE')).toBeUndefined();
        expect(groupSection(result)).not.toContain('ENC-NODE');
    });

    it('emits a comment for Vision + WebSocket', async () => {
        const result = await build(
            `vless://${UUID}@ws.example.com:443?encryption=none&security=tls&type=ws` +
            '&path=%2Fws&flow=xtls-rprx-vision#VISION-WS'
        );

        expect(proxySection(result)).toContain('# VISION-WS - Unsupported VLESS combo: Vision + WebSocket');
        expect(proxyLine(result, 'VISION-WS')).toBeUndefined();
        expect(groupSection(result)).not.toContain('VISION-WS');
    });
});

describe('Surge name sanitization for all proxy types', () => {
    it('sanitizes commas and equals in ss and trojan names', async () => {
        const result = await build(
            [
                'ss://YWVzLTEyOC1nY206dGVzdA@ss.example.com:443#SS,01=a',
                'trojan://pass@tj.example.com:443?security=tls&sni=tj.example.com#TJ,01=a'
            ].join('\n')
        );

        const lines = proxySection(result).split('\n').map(item => item.trim()).filter(Boolean);
        expect(lines.some(line => line.startsWith('SS，01-a = ss, ss.example.com, 443'))).toBe(true);
        expect(lines.some(line => line.startsWith('TJ，01-a = trojan, tj.example.com, 443'))).toBe(true);

        const groupMatch = result.match(/\[Proxy Group\]([\s\S]*?)(?=\n\[|$)/);
        expect(groupMatch[1]).toContain('SS，01-a');
        expect(groupMatch[1]).toContain('TJ，01-a');
        expect(groupMatch[1]).not.toContain('SS,01');
        expect(groupMatch[1]).not.toContain('TJ,01');
    });
});

describe('Surge VLESS extra parameter mapping', () => {
    it('maps alpn on a WebSocket + TLS node and quotes multiple values', async () => {
        const result = await build(
            `vless://${UUID}@ws.example.com:443?encryption=none&security=tls&type=ws` +
            '&host=cdn.example.com&path=%2Fws&sni=cdn.example.com&alpn=h2,http%2F1.1#WS-ALPN'
        );

        const line = proxyLine(result, 'WS-ALPN');
        expect(line).toContain('ws=true');
        expect(line).toContain('tls=true');
        expect(line).toContain('alpn="h2,http/1.1"');
    });

    it('maps grpc-authority and grpc-mode=multi', async () => {
        const result = await build(
            `vless://${UUID}@grpc.example.com:443?encryption=none&security=tls&type=grpc` +
            '&serviceName=mygrpc&authority=grpc.example.com&mode=multi&sni=grpc.example.com#GRPC-MULTI'
        );

        const line = proxyLine(result, 'GRPC-MULTI');
        expect(line).toContain('grpc=true');
        expect(line).toContain('grpc-service-name=mygrpc');
        expect(line).toContain('grpc-mode=multi');
        expect(line).toContain('grpc-authority=grpc.example.com');
        expect(line).toContain('tls=true');
    });
});
