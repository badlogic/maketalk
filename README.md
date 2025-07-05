# maketalk

A command-line tool to create professional video presentations with title cards and transcriptions.

## Features

- Convert MOV files to MP4 with automatic dimension normalization
- Standalone EBU R128 loudness normalization for any video file
- Merge multi-part video sections
- Extract and transcribe audio using Yakety
- Generate beautiful title cards with customizable design
- Create final presentation video with title cards and content

## Prerequisites

### Required:
- Node.js 14+
- FFmpeg
- jq
- Chrome/Chromium (for title card generation)

### Optional:
- Yakety transcribe tool for automatic transcription (or set `YAKD_TRANSCRIBE_PATH` environment variable)
  - Without Yakety, maketalk will generate a template for manual title editing

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

### File Naming Requirements

**Important**: MOV files must follow a specific naming convention:
- Format: `XX-name.mov` where XX is a two-digit section number
- Examples:
  - ✅ `01-introduction.mov`
  - ✅ `02-main-content.mov`
  - ✅ `03-conclusion.mov`
  - ❌ `intro.mov` (missing section number)
  - ❌ `todo-workflow.mov` (missing section number)

### Basic workflow (with Yakety transcription):

1. Place your MOV files in a directory with proper naming (see above)

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

### Manual workflow (without Yakety):

1. Place your MOV files in a directory with proper naming (see above)

2. Run the tool:
   ```bash
   maketalk
   ```

3. The tool will generate:
   - `sections.json` - Information about your video sections
   - `title_cards.json` - Template with placeholder titles

4. Edit `title_cards.json` to add your own titles and descriptions

5. Continue the process:
   ```bash
   maketalk --continue
   ```

6. (Optional) Level the audio of the final presentation:
   ```bash
   maketalk --level-audio final_presentation.mp4
   ```

### Resuming After Conversion

If you need to re-run the process but already have converted videos:

```bash
# This will keep your converted videos and re-do all subsequent steps
maketalk --resume-after-conversion
```

This is useful when:
- You want to regenerate transcriptions
- You need to create different title cards
- Something failed after the conversion step

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
- `--resume-after-conversion`: Resume processing after MOV to MP4 conversion (keeps converted videos)
- `--preview <num> <title> <desc>`: Preview a title card design
- `--help`: Show help information

## Environment Variables

- `YAKD_TRANSCRIBE_PATH`: Path to the Yakety transcribe binary (default: `/Users/badlogic/workspaces/yakety/build/bin/transcribe`)

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