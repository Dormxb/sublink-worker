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
