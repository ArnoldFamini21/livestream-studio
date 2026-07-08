import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from 'werift';
import { SfuMediaTransport, type SfuIceCandidatePayload } from './sfuTransport.js';

/**
 * The publish leg (browser -> server simulcast) is validated by asserting the
 * negotiated SDP shape, because werift can receive rid simulcast but cannot
 * send it, so a werift test client cannot stand in for a publishing browser.
 * Publisher packets are injected through the same entry point the negotiated
 * transceiver uses. The subscribe leg runs fully end-to-end: a real werift
 * subscriber peer over loopback DTLS/SRTP receives the forwarded layer,
 * including a live layer switch and pause.
 */

const CLIENT_VIDEO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: 'video/VP8',
    clockRate: 90000,
    payloadType: 96,
    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
  }),
];

const HIGH_PAYLOAD = 600;
const LOW_PAYLOAD = 60;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(50);
  }
}

function makePacket(sequenceNumber: number, ssrc: number, payloadBytes: number): RtpPacket {
  return new RtpPacket(
    new RtpHeader({
      payloadType: 96,
      sequenceNumber,
      timestamp: sequenceNumber * 3000,
      ssrc,
      marker: true,
    }),
    Buffer.alloc(payloadBytes, 1)
  );
}

describe('SfuMediaTransport', { timeout: 60_000 }, () => {
  const transport = new SfuMediaTransport({
    onIceCandidate: (_participantId, side, candidate) => {
      if (side === 'subscribe') {
        void subscriberClient?.addIceCandidate(candidate as never).catch(() => undefined);
      }
    },
  });

  let subscriberClient: RTCPeerConnection | null = null;

  after(async () => {
    await transport.closeAll();
    await subscriberClient?.close().catch(() => undefined);
  });

  it('negotiates a recv-simulcast publish offer with the requested rids', async () => {
    const offer = await transport.createPublishOffer('alice', ['h', 'l']);
    assert.equal(offer.type, 'offer');
    assert.match(offer.sdp, /a=rid:h recv/);
    assert.match(offer.sdp, /a=rid:l recv/);
    assert.match(offer.sdp, /a=simulcast:recv/);
    assert.match(offer.sdp, /urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id/);
    assert.match(offer.sdp, /VP8\/90000/);
    assert.equal(transport.getPublisherCount(), 1);
  });

  it('rejects publishing without rids and dedupes/caps rid lists', async () => {
    await assert.rejects(() => transport.createPublishOffer('bob', []), /at least one simulcast rid/i);
    const offer = await transport.createPublishOffer('carol', ['h', 'h', 'm', 'l', 'x']);
    const ridLines = offer.sdp.match(/a=rid:\w+ recv/g) || [];
    assert.equal(ridLines.length, 3);
    await transport.closeParticipant('carol');
  });

  it('forwards the selected layer to a real subscriber peer and switches layers live', async () => {
    subscriberClient = new RTCPeerConnection({ codecs: { video: CLIENT_VIDEO_CODECS } });
    const received: Array<{ mid: string | null; size: number }> = [];
    subscriberClient.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      void transport.addSubscribeIceCandidate('bob', {
        candidate: candidate.candidate,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        sdpMid: candidate.sdpMid ?? null,
      } as SfuIceCandidatePayload);
    });
    subscriberClient.onTransceiverAdded.subscribe((transceiver) => {
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((rtp) => {
          received.push({ mid: transceiver.mid ?? null, size: rtp.payload.length });
        });
      });
    });

    const { description: subscribeOffer, producerMids } = await transport.createSubscribeOffer('bob', ['alice']);
    assert.equal(typeof producerMids.alice, 'string');
    await subscriberClient.setRemoteDescription(subscribeOffer as never);
    await subscriberClient.setLocalDescription(await subscriberClient.createAnswer());
    await transport.setSubscribeAnswer('bob', { sdp: subscriberClient.localDescription!.sdp });
    await waitFor(() => subscriberClient!.connectionState === 'connected', 15_000, 'subscriber DTLS connect');

    let sequence = 0;
    const pump = async (packets: number) => {
      for (let i = 0; i < packets; i += 1) {
        sequence += 1;
        transport.injectPublisherRtp('alice', 'h', makePacket(sequence, 1111, HIGH_PAYLOAD));
        transport.injectPublisherRtp('alice', 'l', makePacket(sequence, 2222, LOW_PAYLOAD));
        await delay(10);
      }
    };

    // No layer selected yet: nothing forwards.
    await pump(5);
    await delay(200);
    assert.equal(received.length, 0, 'no packets before a layer is selected');
    const counts = transport.getPublisherRidCounts('alice');
    assert.ok((counts.h || 0) >= 5 && (counts.l || 0) >= 5, 'publisher counters track both rids');

    // Select the high layer.
    transport.setForwardedLayer('bob', 'alice', 'h');
    await pump(20);
    await waitFor(() => received.some((r) => r.size === HIGH_PAYLOAD), 10_000, 'high-layer packets at subscriber');
    assert.ok(received.every((r) => r.mid === producerMids.alice), 'packets arrive on the mapped mid');
    assert.equal(received.some((r) => r.size === LOW_PAYLOAD), false, 'low layer must not leak while h selected');

    // Live switch to the low layer.
    transport.setForwardedLayer('bob', 'alice', 'l');
    received.length = 0;
    await pump(20);
    await waitFor(() => received.some((r) => r.size === LOW_PAYLOAD), 10_000, 'low-layer packets after switch');
    assert.equal(received.some((r) => r.size === HIGH_PAYLOAD), false, 'high layer must stop after switch');

    // Pause forwards nothing.
    transport.setForwardedLayer('bob', 'alice', null);
    received.length = 0;
    await pump(8);
    await delay(300);
    assert.equal(received.length, 0, 'no packets while paused');

    // Producer removal stops forwarding even with a layer re-selected.
    transport.setForwardedLayer('bob', 'alice', 'h');
    transport.removeProducer('alice');
    received.length = 0;
    await pump(8);
    await delay(300);
    assert.equal(received.length, 0, 'no packets after the producer is removed');
  });
});
