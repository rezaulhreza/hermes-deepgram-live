# Hermes Deepgram Live

Talk to your Hermes agent out loud, and hear it talk back, live. There is no record button and no waiting for a recording to finish. You can cut in whenever you like, the same way you would with a person. That is called barge-in.

Deepgram listens and speaks. Your normal Hermes model does all the thinking. Nothing about your model, your tools or your prompts changes.

## Why it feels real time

Nothing waits for anything else. Your voice streams up while you talk, your words stream back while you are still speaking, and the reply streams out loud while Hermes is still writing it. Both directions use live connections, not uploads and downloads.

## How it works

1. Your voice goes to Deepgram over a live connection in 80 millisecond chunks.
2. Deepgram's listening model works out when you have stopped talking and sends back your words as you say them.
3. Each finished sentence goes into the Hermes chat as an ordinary message.
4. The reply is spoken by Deepgram's Aura voice while it is still being written.
5. Barge-in. Speak over a reply and it stops mid-word and drops whatever it was about to say, then Hermes answers what you just said. Say "stop", "stop listening", "goodbye" or "end voice chat" to end the conversation.

Before each tool call, Hermes says one short line about what it is about to do, so you are not left in silence. You can approve actions by voice too.

Because the model is yours, a faster Hermes model feels more live. Thinking time is the slowest part, not the voice.

## What you need

- The Hermes desktop app. The microphone and playback live there, so this will not work from the terminal.
- A Deepgram account and an API key with the Member role. Check Deepgram's pricing page for current costs.

### About the key

Deepgram keys come with a role. This plugin needs the Member role, or higher.

Here is why. Your real key is a master password, so the app never holds it. Instead, the plugin uses your key to ask Deepgram for a temporary pass that lasts 30 seconds, and hands only that pass to the app. Deepgram only checks the pass when a connection opens, so one pass is enough for a long chat. A key below the Member role is not allowed to ask for passes.

If you have a key without the role, make a new one in the Deepgram console, choose Member when it asks, and put the new key in `~/.hermes/.env`. The old one can stay as it is.

Your key never leaves your machine.

## Install

1. Clone this repo and run the installer.

   ```sh
   git clone https://github.com/rezaulhreza/hermes-deepgram-live.git
   cd hermes-deepgram-live
   ./install.sh
   ```

2. Create a key at https://console.deepgram.com/ and choose the Member role (see "About the key" above).
3. Add it to `~/.hermes/.env`.

   ```
   DEEPGRAM_API_KEY=your-key-here
   ```

4. Add `deepgram-live` to the enabled plugins in `~/.hermes/config.yaml`.
5. Restart Hermes.

## Settings

Everything is optional. Add a `deepgram_live` section to `~/.hermes/config.yaml` and change only what you want.

```yaml
deepgram_live:
  voice: aura-2-thalia-en
  listen_model: flux-general-en
  eot_threshold: 0.7
  eot_timeout_ms: 3000
  speed: 1.0
  keyterms:
    - Hermes
  allow_key_fallback: false
```

| Setting | What it does |
| --- | --- |
| `voice` | The Aura voice that speaks. |
| `listen_model` | The Deepgram model that listens. The default is English. Other languages are untested. |
| `eot_threshold` | How sure Deepgram must be that you have finished. Lower answers sooner. Higher waits through pauses. |
| `eot_timeout_ms` | Silence in milliseconds that ends your turn whatever the confidence. |
| `speed` | Speaking speed. 1.0 is normal. |
| `keyterms` | Words that are easy to mishear, such as names. Add your own. |
| `allow_key_fallback` | Only if your key lacks the Member role. Hands the full key to the app's memory. Leave it off if you can. |

## Privacy

Every request to Deepgram asks to stay out of their Model Improvement Program. Your audio and text are not used to train their models. Audio is still sent to Deepgram to be turned into text and speech, so check their terms if that matters to you.

## Troubleshooting

- **"DEEPGRAM_API_KEY is not set"** means the key is missing from `~/.hermes/.env`.
- **"This Deepgram key cannot mint tokens"** means the key does not have the Member role. Make a new one.
- **The voice interrupts itself** means your speakers are being picked up by the microphone. Use headphones.
- **Talking over a reply does not stop it** means the same thing in reverse. Move closer to the microphone or lower the speaker volume.

## Licence

MIT. Do what you like with it. See `LICENSE`.
