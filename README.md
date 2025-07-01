# maketalk

A command-line tool to create professional video presentations with title cards and transcriptions.

## Features

- Convert MOV files to MP4 with automatic dimension normalization
- Standalone EBU R128 loudness normalization for any video file
- Merge multi-part video sections
- Extract and transcribe audio using YakD
- Generate beautiful title cards with customizable design
- Create final presentation video with title cards and content

## Prerequisites

- Node.js 14+
- FFmpeg
- jq
- Chrome/Chromium (for title card generation)
- Yakety transcribe tool (or set `YAKETY_TRANSCRIBE_PATH` environment variable)

## Installation

Install globally:
```bash
npm install -g maketalk
```

Or run with npx:
```bash
npx maketalk
```

## Usage

### Basic workflow:

1. Place your MOV files in a directory (name them with format: `01-intro.mov`, `02-section.mov`, etc.)

2. Run the tool:
   ```bash
   maketalk
   ```

3. Follow the prompts to generate transcriptions and create a prompt for title generation

4. Use claude-danger with the generated prompt to create `title_cards.json`

5. Continue the process:
   ```bash
   maketalk --continue
   ```

6. (Optional) Level the audio of the final presentation:
   ```bash
   maketalk --level-audio final_presentation.mp4
   ```

### Preview title cards:
```bash
maketalk --preview 01 "Claude Code" "The Future of Programming"
```

### Standalone Audio Leveling:
```bash
# Level audio of any video file (in-place)
maketalk --level-audio video.mp4
```

### Command Line Options:
- `--level-audio <file>`: Apply EBU R128 loudness normalization to a single file (standalone operation)
- `--continue`: Continue from the claude-danger step after creating title_cards.json
- `--preview <num> <title> <desc>`: Preview a title card design
- `--help`: Show help information

## Environment Variables

- `YAKD_TRANSCRIBE_PATH`: Path to the YakD transcribe binary (default: `/Users/badlogic/workspaces/yakety/build/bin/transcribe`)

## Output

The tool creates a `generated/` directory with:
- `audio/`: Extracted audio files
- `transcriptions/`: Text transcriptions
- `title_cards/`: Generated title card images and videos
- `converted_videos/`: Processed MP4 files

Final output: `final_presentation.mp4`

## Audio Leveling

The `--level-audio <file>` option applies professional EBU R128 loudness normalization to any video file. This is a standalone operation that:

- Normalizes to -16 LUFS (suitable for online video platforms)
- Updates the file in-place
- Preserves video quality (video stream is copied, not re-encoded)
- Shows before/after audio level analysis

Example workflow:
```bash
# Create the presentation
maketalk

# Level the audio of the final output
maketalk --level-audio final_presentation.mp4
```

Note: Audio leveling requires two passes - one to analyze and one to apply normalization.

## License

ISC