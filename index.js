#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { execSync, spawn } = require('child_process');
const { existsSync, createReadStream, createWriteStream } = require('fs');
const readline = require('readline');

// Colors for output
const colors = {
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  NC: '\x1b[0m' // No Color
};

// Base generated directory
const GENERATED_DIR = 'generated';

// Track all spawned processes for cleanup
const activeProcesses = new Set();

// Cleanup handler
function cleanup() {
  console.log('\n\nCleaning up processes...');
  for (const proc of activeProcesses) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch (e) {
      // Process might already be dead
    }
  }
  activeProcesses.clear();
}

// Register signal handlers
process.on('SIGINT', () => {
  console.log('\n\nReceived SIGINT, cleaning up...');
  cleanup();
  process.exit(1);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(1);
});

process.on('exit', cleanup);

// Helper to execute commands
function exec(command, silent = false) {
  try {
    const result = execSync(command, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' });
    return result;
  } catch (error) {
    if (!silent) {
      console.error(`${colors.RED}Command failed: ${command}${colors.NC}`);
    }
    throw error;
  }
}

// Execute FFmpeg with progress indication
function execFFmpeg(args, description) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });

    activeProcesses.add(ffmpeg);

    let duration = null;
    let lastProgress = -1;

    // Create readline interface for stderr
    const rl = readline.createInterface({
      input: ffmpeg.stderr,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      // Parse duration from input metadata
      if (!duration && line.includes('Duration:')) {
        const match = line.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (match) {
          const [_, hours, minutes, seconds] = match;
          duration = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
        }
      }

      // Parse current time
      if (line.includes('time=')) {
        const match = line.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (match && duration) {
          const [_, hours, minutes, seconds] = match;
          const currentTime = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
          const progress = Math.round((currentTime / duration) * 100);

          // Only update if progress changed
          if (progress !== lastProgress) {
            lastProgress = progress;
            process.stdout.write(`\r  ${description}: ${progress}%`);
          }
        }
      }
    });

    ffmpeg.on('close', (code) => {
      activeProcesses.delete(ffmpeg);
      rl.close();

      if (code === 0) {
        process.stdout.write(`\r  ${description}: 100%\n`);
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      activeProcesses.delete(ffmpeg);
      rl.close();
      reject(err);
    });
  });
}

// Helper to check if command exists
function commandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Initialize/create generated directory structure
async function initGeneratedDir() {
  const dirs = [
    GENERATED_DIR,
    path.join(GENERATED_DIR, 'audio'),
    path.join(GENERATED_DIR, 'transcriptions'),
    path.join(GENERATED_DIR, 'title_cards'),
    path.join(GENERATED_DIR, 'converted_videos')
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Clean up generated directories except converted_videos for resume
async function cleanupForResume() {
  console.log(`${colors.BLUE}Cleaning up for resume (keeping converted videos)...${colors.NC}`);
  
  const dirsToClean = [
    path.join(GENERATED_DIR, 'audio'),
    path.join(GENERATED_DIR, 'transcriptions'),
    path.join(GENERATED_DIR, 'title_cards')
  ];
  
  for (const dir of dirsToClean) {
    try {
      // Remove directory and all contents
      await fs.rm(dir, { recursive: true, force: true });
      // Recreate empty directory
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Directory might not exist, that's ok
    }
  }
  
  // Clean up any files in the root generated directory
  try {
    const files = await fs.readdir(GENERATED_DIR);
    for (const file of files) {
      const filePath = path.join(GENERATED_DIR, file);
      const stat = await fs.stat(filePath);
      if (!stat.isDirectory()) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    // Ignore errors
  }
  
  console.log(`${colors.GREEN}✓ Cleanup complete${colors.NC}`);
}

// Check dependencies
function checkDependencies() {
  console.log(`${colors.BLUE}Checking dependencies...${colors.NC}`);

  const missingDeps = [];
  let yakdAvailable = true;

  if (!commandExists('ffmpeg')) missingDeps.push('ffmpeg');
  if (!commandExists('jq')) missingDeps.push('jq');

  // Check for Yakety transcribe tool - optional
  const yakdPath = process.env.YAKD_TRANSCRIBE_PATH || '/Users/badlogic/workspaces/yakety/build/bin/transcribe';
  if (!existsSync(yakdPath)) {
    yakdAvailable = false;
    console.log(`${colors.YELLOW}Note: Yakety transcribe tool not found - will generate template for manual editing${colors.NC}`);
  }

  // Check for Chrome
  const chromeExists = commandExists('google-chrome') ||
                      commandExists('chromium') ||
                      existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

  if (!chromeExists) {
    missingDeps.push('Chrome/Chromium for title card generation');
  }

  if (missingDeps.length > 0) {
    console.error(`${colors.RED}Missing required dependencies: ${missingDeps.join(', ')}${colors.NC}`);
    process.exit(1);
  }

  console.log(`${colors.GREEN}All required dependencies found!${colors.NC}`);
  return yakdAvailable;
}

// Get all MOV files in current directory
async function getMovFiles() {
  const files = await fs.readdir('.');
  return files.filter(f => f.toLowerCase().endsWith('.mov'));
}

// Check if MOV files follow naming convention
function checkMovFileNaming(movFiles) {
  const numberedFiles = [];
  const unnumberedFiles = [];
  
  for (const file of movFiles) {
    if (file.match(/^(\d{2})-/)) {
      numberedFiles.push(file);
    } else {
      unnumberedFiles.push(file);
    }
  }
  
  return { numberedFiles, unnumberedFiles };
}

// Step 3: Extract audio from merged section MP4 files
async function extractAudio() {
  console.log(`\n${colors.BLUE}Step 3: Extracting audio from merged section MP4 files...${colors.NC}`);

  const convertedDir = path.join(GENERATED_DIR, 'converted_videos');
  const mp4Files = await fs.readdir(convertedDir);
  // Only extract audio from section files (XX-section.mp4)
  const sectionFiles = mp4Files.filter(f => f.match(/^\d{2}-section\.mp4$/));

  for (const file of sectionFiles) {
    const filename = path.basename(file, '.mp4');
    const mp4Path = path.join(convertedDir, file);
    console.log(`Extracting audio from ${file}...`);

    try {
      const outputPath = path.join(GENERATED_DIR, 'audio', filename + '.wav');
      await execFFmpeg([
        '-i', mp4Path,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-y',
        outputPath
      ], `Extracting ${filename}`);
      console.log(`${colors.GREEN}✓ Extracted: ${filename}.wav${colors.NC}`);
    } catch {
      console.log(`${colors.RED}✗ Failed: ${filename}.wav${colors.NC}`);
    }
  }
}

// Step 4: Transcribe audio files (if Yakety available)
async function transcribeAudio(yakdAvailable) {
  if (!yakdAvailable) {
    console.log(`\n${colors.YELLOW}Step 4: Skipping transcription (Yakety not available)${colors.NC}`);
    return false;
  }
  
  console.log(`\n${colors.BLUE}Step 4: Transcribing audio files...${colors.NC}`);

  const audioDir = path.join(GENERATED_DIR, 'audio');
  const files = await fs.readdir(audioDir);
  const wavFiles = files.filter(f => f.endsWith('.wav'));

  for (const wavFile of wavFiles) {
    const basename = path.basename(wavFile, '.wav');
    console.log(`Transcribing ${basename}...`);

    try {
      const wavPath = path.join(audioDir, wavFile);
      const yakdPath = process.env.YAKD_TRANSCRIBE_PATH || '/Users/badlogic/workspaces/yakety/build/bin/transcribe';
      const result = exec(`"${yakdPath}" "${wavPath}" 2>&1`, true);

      // Extract transcription from output
      const match = result.match(/Transcription: "(.*?)"/);
      if (match && match[1]) {
        const transcriptionPath = path.join(GENERATED_DIR, 'transcriptions', `${basename}.txt`);
        await fs.writeFile(transcriptionPath, match[1]);
        console.log(`${colors.GREEN}✓ Transcribed: ${basename}.txt${colors.NC}`);
      } else {
        console.log(`${colors.RED}✗ Failed: ${basename}.txt${colors.NC}`);
      }
    } catch {
      console.log(`${colors.RED}✗ Failed: ${basename}.txt${colors.NC}`);
    }
  }
}

// Generate template title_cards.json when Yakety is not available
async function generateTemplateForManualEdit() {
  console.log(`\n${colors.BLUE}Step 5: Generating template files for manual editing...${colors.NC}`);
  
  // Get all section videos
  const convertedDir = path.join(GENERATED_DIR, 'converted_videos');
  const mp4Files = await fs.readdir(convertedDir);
  const sectionFiles = mp4Files.filter(f => f.match(/^\d{2}-section\.mp4$/)).sort();
  
  // Generate sections info
  const sections = [];
  const titleCards = [];
  
  for (const file of sectionFiles) {
    const sectionNum = file.substring(0, 2);
    const filename = path.basename(file, '.mp4');
    
    sections.push({
      number: sectionNum,
      filename: file,
      duration: "[run 'ffprobe' to get duration]"
    });
    
    titleCards.push({
      number: sectionNum,
      title: `Section ${sectionNum} Title`,
      description: `Description for section ${sectionNum}`
    });
  }
  
  // Write sections.json
  const sectionsJson = {
    sections: sections,
    note: "This file contains information about your video sections"
  };
  await fs.writeFile('sections.json', JSON.stringify(sectionsJson, null, 2));
  
  // Write title_cards.json template
  const titleCardsJson = {
    title_cards: titleCards,
    instructions: [
      "Please edit the title and description for each section",
      "Keep titles short and punchy (max 6-8 words)",
      "Keep descriptions concise (max 10-12 words)",
      "Save this file and run 'maketalk --continue' when done"
    ]
  };
  await fs.writeFile('title_cards.json', JSON.stringify(titleCardsJson, null, 2));
  
  console.log(`\n${colors.GREEN}✓ Created template files:${colors.NC}`);
  console.log(`   - sections.json (for reference)`);
  console.log(`   - title_cards.json (please edit this)`);
  console.log(`\n${colors.YELLOW}Next steps:${colors.NC}`);
  console.log(`1. Edit title_cards.json with your section titles and descriptions`);
  console.log(`2. Run: maketalk --continue`);
  console.log(`\n${colors.BLUE}Tip:${colors.NC} You can preview title cards before finalizing:`);
  console.log(`   maketalk --preview 01 "Your Title" "Your Description"`);
}

// Step 5: Generate claude-danger prompt
async function generateClaudePrompt() {
  console.log(`\n${colors.BLUE}Step 5: Checking for existing title cards or generating claude-danger prompt...${colors.NC}`);

  // Check if title_cards.json already exists
  if (existsSync('title_cards.json')) {
    console.log(`\n${colors.YELLOW}Found existing title_cards.json${colors.NC}`);

    // Read the existing title cards
    const titleCardsData = JSON.parse(await fs.readFile('title_cards.json', 'utf8'));
    const existingSections = new Set(titleCardsData.title_cards.map(card => card.number));

    // Get all section videos to check if they match
    const convertedDir = path.join(GENERATED_DIR, 'converted_videos');
    const mp4Files = await fs.readdir(convertedDir);
    const sectionFiles = mp4Files.filter(f => f.match(/^\d{2}-section\.mp4$/));
    const videoSections = new Set(sectionFiles.map(f => f.substring(0, 2)));

    // Check if all video sections have title cards
    const allSectionsHaveTitles = Array.from(videoSections).every(section => existingSections.has(section));

    if (allSectionsHaveTitles) {
      console.log('\nThe existing title_cards.json has title cards for all video sections.');
      console.log('\nDo you want to use the existing title cards? (y/n):');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise(resolve => {
        rl.question('', answer => {
          rl.close();
          resolve(answer.trim().toLowerCase());
        });
      });

      if (answer === 'y' || answer === 'yes') {
        console.log(`\n${colors.GREEN}Using existing title_cards.json${colors.NC}`);
        return true; // Signal to skip prompt generation but continue
      }
    } else {
      console.log(`\n${colors.YELLOW}Warning: Existing title_cards.json doesn't match all video sections${colors.NC}`);
      console.log('Will generate a new prompt for claude-danger...');
    }
  }

  const transcriptionsDir = path.join(GENERATED_DIR, 'transcriptions');
  const files = await fs.readdir(transcriptionsDir);
  const txtFiles = files.filter(f => f.endsWith('.txt')).sort();

  // Group transcriptions by section number
  const sections = {};

  for (const file of txtFiles) {
    const basename = path.basename(file, '.txt');
    // Extract section number (first two digits)
    const sectionMatch = basename.match(/^(\d{2})/);

    if (sectionMatch) {
      const sectionNum = sectionMatch[1];
      const content = await fs.readFile(path.join(transcriptionsDir, file), 'utf8');

      if (!sections[sectionNum]) {
        sections[sectionNum] = [];
      }
      sections[sectionNum].push(content);
    }
  }

  // Create combined transcriptions file
  let combinedContent = '# Video Transcriptions\n\n';

  // Sort sections numerically
  const sortedSections = Object.keys(sections).sort();

  for (const sectionNum of sortedSections) {
    combinedContent += `## Section ${sectionNum}\n\n`;
    combinedContent += sections[sectionNum].join('\n\n');
    combinedContent += '\n\n---\n\n';
  }

  await fs.writeFile(path.join(GENERATED_DIR, 'transcriptions_combined.md'), combinedContent);

  // Create the prompt file
  const promptTemplate = `I have a video presentation split into multiple sections. I need you to help me create compelling title cards for each section.

Please read the transcriptions below and suggest:
1. A short, punchy title (max 6-8 words)
2. A descriptive subtitle (max 10-12 words)

The titles should be:
- Clear and engaging
- Consistent in style
- Professional but not boring
- Focused on the key message of each section

After we agree on the titles, please save them in a JSON file called \`title_cards.json\` with this format:
\`\`\`json
{
  "title_cards": [
    {
      "number": "01",
      "title": "Title Here",
      "description": "Description here"
    },
    ...
  ]
}
\`\`\`

Here are the transcriptions:

`;

  const fullPrompt = promptTemplate + combinedContent;
  await fs.writeFile(path.join(GENERATED_DIR, 'claude_prompt.txt'), fullPrompt);

  console.log(`\n${colors.GREEN}Claude prompt saved to: ${GENERATED_DIR}/claude_prompt.txt${colors.NC}`);
  console.log(`${colors.YELLOW}Instructions:${colors.NC}`);
  console.log('1. Run: claude-danger');
  console.log(`2. Copy and paste the contents of ${GENERATED_DIR}/claude_prompt.txt`);
  console.log('3. Iterate on the titles until you\'re happy');
  console.log('4. Have Claude save the final titles to title_cards.json (in this directory)');
  console.log('5. Run this script again with --continue flag');
}

// Generate title card HTML
function generateTitleCardHTML(number, title, description, width = 3456, height = 2234) {
  return `<!DOCTYPE html>
<html>
<head>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap');

* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    width: ${width}px;
    height: ${height}px;
    background: #faf8f3;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
}

/* Main container */
.container {
    width: 75%;
    height: 65%;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}

/* Section number - refined */
.section-number {
    font-size: 24px;
    font-weight: 300;
    letter-spacing: 16px;
    color: #999;
    margin-bottom: 120px;
    text-transform: uppercase;
}

/* Title - bold statement */
.title {
    font-size: 200px;
    font-weight: 600;
    letter-spacing: -8px;
    line-height: 0.85;
    margin-bottom: 80px;
    color: #1a1a1a;
    text-transform: uppercase;
}

/* Description - elegant */
.description {
    font-size: 36px;
    font-weight: 300;
    letter-spacing: 4px;
    color: #666;
    margin-bottom: 120px;
    text-transform: uppercase;
}

/* Rainbow dots accent */
.rainbow-dots {
    position: absolute;
    left: 12.5%;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 30px;
}

.dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    opacity: 0.7;
}

.dot-1 { background: #61BB46; }
.dot-2 { background: #FDB827; }
.dot-3 { background: #F5821F; }
.dot-4 { background: #E03A3E; }
.dot-5 { background: #963D97; }
.dot-6 { background: #009DDC; }

/* Alternative: Rainbow accent bar */
.color-bar {
    position: absolute;
    top: 48%;
    right: 12.5%;
    width: 140px;
    height: 5px;
    display: flex;
    gap: 2px;
}

.segment {
    flex: 1;
    height: 100%;
}

.segment-1 { background: #61BB46; }
.segment-2 { background: #FDB827; }
.segment-3 { background: #F5821F; }
.segment-4 { background: #E03A3E; }
.segment-5 { background: #963D97; }
.segment-6 { background: #009DDC; }

/* Subtle geometric elements */
.corner-accent {
    position: absolute;
    width: 60px;
    height: 60px;
}

.corner-accent::before,
.corner-accent::after {
    content: '';
    position: absolute;
    background: #ddd;
}

.corner-accent.top-left {
    top: 15%;
    left: 12.5%;
}

.corner-accent.top-left::before {
    width: 60px;
    height: 1px;
}

.corner-accent.top-left::after {
    width: 1px;
    height: 60px;
}

.corner-accent.bottom-right {
    bottom: 15%;
    right: 12.5%;
}

.corner-accent.bottom-right::before {
    width: 60px;
    height: 1px;
    right: 0;
    bottom: 0;
}

.corner-accent.bottom-right::after {
    width: 1px;
    height: 60px;
    right: 0;
    bottom: 0;
}

/* Grid pattern */
.grid {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-image:
        linear-gradient(0deg, rgba(0,0,0,0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,0,0,0.02) 1px, transparent 1px);
    background-size: 40px 40px;
}

</style>
</head>
<body>
    <div class="grid"></div>

    <div class="corner-accent top-left"></div>
    <div class="corner-accent bottom-right"></div>

    <div class="rainbow-dots">
        <div class="dot dot-1"></div>
        <div class="dot dot-2"></div>
        <div class="dot dot-3"></div>
        <div class="dot dot-4"></div>
        <div class="dot dot-5"></div>
        <div class="dot dot-6"></div>
    </div>

    <div class="color-bar">
        <div class="segment segment-1"></div>
        <div class="segment segment-2"></div>
        <div class="segment segment-3"></div>
        <div class="segment segment-4"></div>
        <div class="segment segment-5"></div>
        <div class="segment segment-6"></div>
    </div>

    <div class="container">
        <div class="section-number">SECTION ${number}</div>
        <div class="title">${title}</div>
        <div class="description">${description}</div>
    </div>

</body>
</html>`;
}

// Generate title card image
async function generateTitleCard(number, title, description, output, previewMode = false) {
  const width = 3456;
  const height = 2234;

  // Create temporary HTML file
  const htmlFile = `./title_card_${process.pid}.html`;
  const htmlContent = generateTitleCardHTML(number, title, description, width, height);
  await fs.writeFile(htmlFile, htmlContent);

  if (previewMode) {
    // Preview mode - just move HTML to output location
    await fs.rename(htmlFile, output);
    console.log(`Preview HTML generated: ${output}`);
    console.log(`Open in browser: file://${path.resolve(output)}`);
  } else {
    // Take screenshot using Chrome
    let chromeCmd;
    if (commandExists('google-chrome')) {
      chromeCmd = 'google-chrome';
    } else if (commandExists('chromium')) {
      chromeCmd = 'chromium';
    } else if (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
      chromeCmd = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else {
      console.error('Error: Chrome/Chromium not found. Please install Chrome.');
      await fs.unlink(htmlFile);
      return;
    }

    const htmlFileAbs = path.resolve(htmlFile);
    try {
      exec(`"${chromeCmd}" --headless --disable-gpu --screenshot="${output}" --window-size=${width},${height} "file://${htmlFileAbs}" 2>/dev/null`, true);
    } catch (error) {
      console.error(`Failed to generate title card: ${error.message}`);
    }

    // Clean up
    await fs.unlink(htmlFile);
  }
}

// Step 6: Generate title card images
async function generateTitleCards() {
  console.log(`\n${colors.BLUE}Step 6: Generating title card images...${colors.NC}`);

  if (!existsSync('title_cards.json')) {
    console.error(`${colors.RED}Error: title_cards.json not found!${colors.NC}`);
    console.log('Please run claude-danger first to generate the titles.');
    process.exit(1);
  }

  const titleCardsData = JSON.parse(await fs.readFile('title_cards.json', 'utf8'));

  for (const card of titleCardsData.title_cards) {
    const { number, title, description } = card;

    console.log(`Creating title card for Section ${number}...`);

    // Generate PNG
    const pngPath = path.join(GENERATED_DIR, 'title_cards', `${number}-title.png`);
    await generateTitleCard(number, title, description, pngPath);

    // Create 5-second video from title card
    const mp4Path = path.join(GENERATED_DIR, 'title_cards', `${number}-title.mp4`);
    try {
      await execFFmpeg([
        '-loop', '1',
        '-i', pngPath,
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264',
        '-t', '5',
        '-pix_fmt', 'yuv420p',
        '-r', '30',  // 30fps for YouTube compatibility
        '-crf', '18',  // Better quality for text
        '-bf', '2',  // Maximum 2 B-frames
        '-flags', '+cgop',  // Closed GOP
        '-c:a', 'aac',
        '-b:a', '192k',  // Higher bitrate
        '-ac', '2',  // Stereo
        '-ar', '48000',  // 48kHz
        '-movflags', 'faststart',  // Fast start
        '-shortest',
        '-y',
        mp4Path
      ], `Creating title video ${number}`);
      console.log(`${colors.GREEN}✓ Created: ${number}-title.mp4${colors.NC}`);
    } catch {
      console.log(`${colors.RED}✗ Failed: ${number}-title.mp4${colors.NC}`);
    }
  }
}

// Step 1: Convert MOV to MP4 with dimension fixes
async function convertVideos() {
  console.log(`\n${colors.BLUE}Step 1: Converting MOV files to MP4...${colors.NC}`);

  const movFiles = await getMovFiles();

  // First, check all MOV dimensions BEFORE conversion
  console.log('Checking MOV file dimensions...');
  const videoDimensions = new Map();
  const dimensionCounts = new Map();

  for (const file of movFiles) {
    try {
      const result = exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${file}"`, true);
      const info = JSON.parse(result);
      const width = info.streams[0].width;
      const height = info.streams[0].height;
      const dimensions = `${width}x${height}`;

      videoDimensions.set(file, { width, height, dimensions });
      dimensionCounts.set(dimensions, (dimensionCounts.get(dimensions) || 0) + 1);
    } catch (error) {
      console.error(`${colors.RED}Error checking dimensions for ${file}${colors.NC}`);
    }
  }

  let targetWidth = null;
  let targetHeight = null;

  // Check if all videos have the same dimensions
  if (dimensionCounts.size > 1) {
    console.log(`\n${colors.YELLOW}Warning: MOV files have different dimensions:${colors.NC}`);
    for (const [dims, count] of dimensionCounts) {
      console.log(`  ${dims}: ${count} video(s)`);
    }

    // Find the most common dimension
    let maxDimension = '';
    let maxCount = 0;
    for (const [dims, count] of dimensionCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxDimension = dims;
      }
    }

    console.log(`\n${colors.YELLOW}Most common dimension: ${maxDimension}${colors.NC}`);
    console.log('\nOptions:');
    console.log('1. Convert all videos to the most common dimension (may add black bars)');
    console.log('2. Exit and fix manually');

    // Simple prompt for user choice
    console.log('\nPlease choose (1 or 2):');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('', answer => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (answer !== '1') {
      console.log(`\n${colors.YELLOW}Exiting. Please ensure all videos have the same dimensions before running again.${colors.NC}`);
      process.exit(0);
    }

    // Parse target dimensions
    [targetWidth, targetHeight] = maxDimension.split('x').map(Number);
  }

  // Now convert with dimension fixes and audio normalization in one pass
  console.log('\nConverting MOV files to MP4...');
  for (const file of movFiles) {
    const filename = path.basename(file, path.extname(file));
    const videoDim = videoDimensions.get(file);

    console.log(`Converting ${file} to MP4...`);
    try {
      let ffmpegCmd;

      const outputPath = path.join(GENERATED_DIR, 'converted_videos', filename + '.mp4');
      const args = ['-i', file];

      // Build video filter chain
      let videoFilter = '';
      if (targetWidth && targetHeight && (videoDim.width !== targetWidth || videoDim.height !== targetHeight)) {
        const padX = Math.floor((targetWidth - videoDim.width) / 2);
        const padY = Math.floor((targetHeight - videoDim.height) / 2);
        console.log(`  Adding padding: ${videoDim.dimensions} -> ${targetWidth}x${targetHeight}`);
        videoFilter = `pad=${targetWidth}:${targetHeight}:${padX}:${padY}:black`;
      }

      // Apply filters
      if (videoFilter) {
        args.push('-vf', videoFilter);
      }

      args.push(
        '-r', '30',  // Force 30fps for YouTube compatibility
        '-c:v', 'libx264',
        '-crf', '18',  // Better quality for text clarity
        '-bf', '2',  // Maximum 2 B-frames for YouTube
        '-flags', '+cgop',  // Closed GOP for YouTube
        '-pix_fmt', 'yuv420p',  // Ensure compatible pixel format
        '-af', 'pan=stereo|c0=c0|c1=c0,aresample=48000',  // Convert to stereo and 48kHz
        '-c:a', 'aac',
        '-b:a', '192k',  // Higher bitrate for better audio
        '-ac', '2',  // Stereo audio
        '-ar', '48000',  // 48kHz sample rate for YouTube
        '-movflags', 'faststart',  // MOOV atom at front for streaming
        '-y',
        outputPath
      );

      await execFFmpeg(args, `Converting ${filename}`);
      console.log(`${colors.GREEN}✓ Converted: ${filename}${colors.NC}`);
    } catch {
      console.log(`${colors.RED}✗ Failed: ${filename}${colors.NC}`);
    }
  }
}

// Step 2: Merge multi-part sections
async function mergeMultipartSections() {
  console.log(`\n${colors.BLUE}Step 2: Merging multi-part sections...${colors.NC}`);

  const convertedDir = path.join(GENERATED_DIR, 'converted_videos');
  const files = await fs.readdir(convertedDir);

  // Group files by section number
  const sections = {};
  
  for (const file of files) {
    const match = file.match(/^(\d{2})-/);
    if (match) {
      const sectionNum = match[1];
      if (!sections[sectionNum]) {
        sections[sectionNum] = [];
      }
      sections[sectionNum].push(file);
    }
  }

  // Process each section
  for (const [sectionNum, sectionFiles] of Object.entries(sections)) {
    if (sectionFiles.length > 1) {
      console.log(`Found multi-part section ${sectionNum} with ${sectionFiles.length} parts`);

      // Sort files to ensure correct order
      sectionFiles.sort();

      // Create concat file
      const concatFile = path.join(GENERATED_DIR, `concat_${sectionNum}.txt`);
      let concatContent = '';

      for (const file of sectionFiles) {
        concatContent += `file '${path.resolve(convertedDir, file)}'\n`;
      }

      await fs.writeFile(concatFile, concatContent);

      // Merge parts
      const outputPath = path.join(convertedDir, `${sectionNum}-section.mp4`);
      try {
        await execFFmpeg([
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFile,
          '-c', 'copy',
          '-y',
          outputPath
        ], `Merging section ${sectionNum}`);

        // Clean up
        await fs.unlink(concatFile);
        for (const file of sectionFiles) {
          if (!file.endsWith('-section.mp4')) {
            await fs.unlink(path.join(convertedDir, file));
          }
        }

        console.log(`${colors.GREEN}✓ Merged section ${sectionNum}${colors.NC}`);
      } catch {
        console.log(`${colors.RED}✗ Failed to merge section ${sectionNum}${colors.NC}`);
      }
    } else if (sectionFiles.length === 1) {
      // Single part section - rename for consistency
      const oldPath = path.join(convertedDir, sectionFiles[0]);
      const newPath = path.join(convertedDir, `${sectionNum}-section.mp4`);
      try {
        await fs.rename(oldPath, newPath);
      } catch {
        // File might already be named correctly
      }
    }
  }
}

// Step 7: Create final video
async function createFinalVideo() {
  console.log(`\n${colors.BLUE}Step 7: Creating final video...${colors.NC}`);

  // Create concatenation list
  const concatFile = path.join(GENERATED_DIR, 'final_concat.txt');
  let concatContent = '';

  // Get all section numbers from title cards
  const titleCardsDir = path.join(GENERATED_DIR, 'title_cards');
  const titleCards = await fs.readdir(titleCardsDir);
  const mp4TitleCards = titleCards.filter(f => f.match(/^\d{2}-title\.mp4$/)).sort();

  for (const titleCard of mp4TitleCards) {
    const sectionNum = titleCard.substring(0, 2);
    const titleCardPath = path.join(titleCardsDir, titleCard);
    const sectionVideoPath = path.join(GENERATED_DIR, 'converted_videos', `${sectionNum}-section.mp4`);

    if (existsSync(sectionVideoPath)) {
      concatContent += `file '${path.resolve(titleCardPath)}'\n`;
      concatContent += `file '${path.resolve(sectionVideoPath)}'\n`;
    }
  }

  if (!concatContent) {
    console.error(`${colors.RED}Error: No videos to concatenate!${colors.NC}`);
    process.exit(1);
  }

  await fs.writeFile(concatFile, concatContent);

  console.log('Merging all segments...');
  try {
    // Use copy codec for fast concatenation (all videos now have matching parameters)
    await execFFmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      '-y',
      'final_presentation.mp4'
    ], 'Creating final video');

    if (existsSync('final_presentation.mp4')) {
      const duration = exec('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 final_presentation.mp4', true).trim();
      const minutes = Math.round(parseFloat(duration) / 60);
      console.log(`\n${colors.GREEN}✅ Success! Final video created:${colors.NC}`);
      console.log('   Output: final_presentation.mp4');
      console.log(`   Duration: approximately ${minutes} minutes`);
    }
  } catch {
    console.log(`\n${colors.RED}❌ Error: Failed to create final video${colors.NC}`);
  }
}

// Preview title card function
async function previewTitleCard(number, title, description) {
  console.log(`${colors.BLUE}Generating title card preview...${colors.NC}`);
  await generateTitleCard(number, title, description, 'preview_title_card.html', true);
}

// Analyze audio levels for loudnorm (first pass)
async function analyzeLoudnorm(inputFile) {
  try {
    const result = exec(`ffmpeg -i "${inputFile}" -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1`, true);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse loudnorm analysis');
    }
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error(`${colors.YELLOW}Warning: Could not analyze audio levels${colors.NC}`);
    return null;
  }
}

// Standalone audio leveling function
async function levelAudioStandalone(inputFile, targetLoudness = -16) {
  console.log(`${colors.BLUE}=== Audio Leveling Tool ===${colors.NC}`);
  console.log(`Input: ${inputFile}`);
  console.log(`Target: ${targetLoudness} LUFS`);

  // Check if input file exists
  if (!existsSync(inputFile)) {
    console.error(`${colors.RED}Error: Input file not found: ${inputFile}${colors.NC}`);
    process.exit(1);
  }

  // Generate temporary filename
  const ext = path.extname(inputFile);
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, ext);
  const tempFile = path.join(dir, `${base}_temp_${Date.now()}${ext}`);

  try {
    // First pass - analyze
    console.log(`\n${colors.BLUE}Analyzing audio levels...${colors.NC}`);
    const loudnormStats = await analyzeLoudnorm(inputFile);

    if (!loudnormStats) {
      throw new Error('Failed to analyze audio levels');
    }

    console.log(`${colors.GREEN}Current audio levels:${colors.NC}`);
    console.log(`  Integrated Loudness: ${loudnormStats.input_i} LUFS`);
    console.log(`  True Peak: ${loudnormStats.input_tp} dB`);
    console.log(`  Loudness Range: ${loudnormStats.input_lra} LU`);

    // Second pass - apply normalization
    console.log(`\n${colors.BLUE}Applying audio leveling...${colors.NC}`);

    const filterComplex = `loudnorm=I=${targetLoudness}:TP=-1.5:LRA=11:measured_I=${loudnormStats.input_i}:measured_LRA=${loudnormStats.input_lra}:measured_TP=${loudnormStats.input_tp}:measured_thresh=${loudnormStats.input_thresh}:offset=${loudnormStats.target_offset}:linear=true:print_format=summary`;

    await execFFmpeg([
      '-i', inputFile,
      '-af', filterComplex,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y',
      tempFile
    ], 'Leveling audio');

    // Replace original with leveled version
    await fs.unlink(inputFile);
    await fs.rename(tempFile, inputFile);

    console.log(`\n${colors.GREEN}✓ Audio leveling complete!${colors.NC}`);
    console.log(`   File updated in place: ${inputFile}`);

    // Verify the output
    console.log(`\n${colors.BLUE}Verifying output levels...${colors.NC}`);
    const verifyStats = await analyzeLoudnorm(inputFile);
    if (verifyStats) {
      console.log(`${colors.GREEN}New audio levels:${colors.NC}`);
      console.log(`  Integrated Loudness: ${verifyStats.input_i} LUFS`);
      console.log(`  True Peak: ${verifyStats.input_tp} dB`);
    }

  } catch (error) {
    // Clean up temp file if it exists
    if (existsSync(tempFile)) {
      await fs.unlink(tempFile);
    }
    console.error(`${colors.RED}Error: ${error.message}${colors.NC}`);
    process.exit(1);
  }
}

// Main function
async function main() {
  const args = process.argv.slice(2);

  // Check for preview mode
  // Handle help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${colors.BLUE}maketalk${colors.NC}`);
    console.log('\nUsage:');
    console.log('  maketalk [options]');
    console.log('  maketalk --level-audio <file>');
    console.log('\nOptions:');
    console.log('  --continue                Continue from claude-danger step');
    console.log('  --resume-after-conversion Resume after MOV to MP4 conversion');
    console.log('  --level-audio <file>      Level audio of a single file (standalone operation)');
    console.log('  --preview                 Preview a title card');
    console.log('  --help, -h                Show this help');
    console.log('\nExamples:');
    console.log('  maketalk                                    # Create video presentation');
    console.log('  maketalk --resume-after-conversion          # Resume after conversion step');
    console.log('  maketalk --level-audio final.mp4            # Level audio of a file');
    console.log('  maketalk --continue                         # Continue after title generation');
    console.log('  maketalk --preview 01 "Title" "Description" # Preview a title card');
    process.exit(0);
  }

  // Handle preview mode
  if (args.includes('--preview')) {
    const previewIndex = args.indexOf('--preview');
    if (args.length < previewIndex + 4) {
      console.log('Usage: maketalk --preview <number> <title> <description>');
      console.log('Example: maketalk --preview 01 "Claude Code" "The Future of Programming"');
      process.exit(1);
    }

    await previewTitleCard(args[previewIndex + 1], args[previewIndex + 2], args[previewIndex + 3]);
    return;
  }

  // Handle standalone audio leveling
  if (args.includes('--level-audio')) {
    const levelIndex = args.indexOf('--level-audio');
    if (args.length <= levelIndex + 1) {
      console.error(`${colors.RED}Error: --level-audio requires a file path${colors.NC}`);
      console.log('Usage: maketalk --level-audio <input.mp4>');
      process.exit(1);
    }

    const inputFile = args[levelIndex + 1];
    await levelAudioStandalone(inputFile);
    return; // Exit after leveling
  }

  console.log(`${colors.BLUE}=== maketalk ===${colors.NC}`);

  // Parse command line options
  const continueMode = args.includes('--continue');
  const resumeAfterConversion = args.includes('--resume-after-conversion');

  // Initialize generated directory
  await initGeneratedDir();

  // Check if we're resuming after conversion
  if (resumeAfterConversion) {
    // Check that converted_videos directory exists and has files
    const convertedDir = path.join(GENERATED_DIR, 'converted_videos');
    if (!existsSync(convertedDir)) {
      console.error(`${colors.RED}Error: No converted videos found at ${convertedDir}${colors.NC}`);
      console.error('Please run maketalk without --resume-after-conversion first');
      process.exit(1);
    }
    
    const convertedFiles = await fs.readdir(convertedDir);
    const mp4Files = convertedFiles.filter(f => f.endsWith('.mp4'));
    
    if (mp4Files.length === 0) {
      console.error(`${colors.RED}Error: No MP4 files found in ${convertedDir}${colors.NC}`);
      console.error('Please run maketalk without --resume-after-conversion first');
      process.exit(1);
    }
    
    console.log(`${colors.GREEN}Found ${mp4Files.length} converted video(s)${colors.NC}`);
    
    // Clean up other directories
    await cleanupForResume();
    
    // Run steps 2 onwards
    const yakdAvailable = checkDependencies();
    await mergeMultipartSections();  // Step 2: Merge multi-part sections
    
    if (yakdAvailable) {
      await extractAudio();  // Step 3: Extract audio from merged sections only
      await transcribeAudio(yakdAvailable);  // Step 4: Transcribe
      const skipPrompt = await generateClaudePrompt();  // Step 5: Generate prompt

      if (skipPrompt === true) {
        // User chose to use existing title_cards.json
        await generateTitleCards();
        await createFinalVideo();
      } else {
        console.log(`\n${colors.YELLOW}Next steps:${colors.NC}`);
        console.log('1. Run: claude-danger');
        console.log(`2. Copy and paste the contents of ${GENERATED_DIR}/claude_prompt.txt`);
        console.log('3. Work with Claude to refine the titles');
        console.log('4. Have Claude save the results to title_cards.json');
        console.log('5. Run: maketalk --continue');
      }
    } else {
      // Yakety not available - generate template
      await generateTemplateForManualEdit();
    }
    
    return; // Exit after resume flow
  }

  // Check if we're continuing from claude-danger
  if (continueMode) {
    if (!existsSync('title_cards.json')) {
      console.error(`${colors.RED}Error: title_cards.json not found!${colors.NC}`);
      console.log('Please create title_cards.json first by:');
      console.log('1. Running maketalk to generate the template');
      console.log('2. Editing the titles and descriptions');
      console.log('3. Running maketalk --continue');
      process.exit(1);
    }

    const yakdAvailable = checkDependencies();
    await generateTitleCards();
    await createFinalVideo();
  } else {
    // Full run
    const yakdAvailable = checkDependencies();
    
    // Check MOV file naming before starting
    const movFiles = await getMovFiles();
    if (movFiles.length === 0) {
      console.error(`${colors.RED}Error: No .mov files found in current directory${colors.NC}`);
      process.exit(1);
    }
    
    const { numberedFiles, unnumberedFiles } = checkMovFileNaming(movFiles);
    
    if (unnumberedFiles.length > 0) {
      console.error(`\n${colors.RED}Error: MOV files must follow the naming convention: XX-name.mov${colors.NC}`);
      console.error(`       where XX is a two-digit section number (01, 02, etc.)\n`);
      console.error(`${colors.YELLOW}Files that need to be renamed:${colors.NC}`);
      
      for (const file of unnumberedFiles) {
        console.error(`  ❌ ${file}`);
      }
      
      console.error(`\n${colors.BLUE}Examples of correct naming:${colors.NC}`);
      console.error(`  ✓ 01-introduction.mov`);
      console.error(`  ✓ 02-main-content.mov`);
      console.error(`  ✓ 03-conclusion.mov`);
      
      console.error(`\n${colors.YELLOW}To rename a file, use:${colors.NC}`);
      console.error(`  mv "${unnumberedFiles[0]}" "01-${unnumberedFiles[0]}"`);
      
      process.exit(1);
    }
    
    console.log(`${colors.GREEN}Found ${numberedFiles.length} properly named MOV file(s)${colors.NC}`);
    
    await convertVideos();  // Step 1: Convert with dimension fix
    await mergeMultipartSections();  // Step 2: Merge multi-part sections
    
    if (yakdAvailable) {
      await extractAudio();  // Step 3: Extract audio from merged sections only
      await transcribeAudio(yakdAvailable);  // Step 4: Transcribe
      const skipPrompt = await generateClaudePrompt();  // Step 5: Generate prompt

    if (skipPrompt === true) {
      // User chose to use existing title_cards.json
      await generateTitleCards();
      await createFinalVideo();
    } else {
      console.log(`\n${colors.YELLOW}Next steps:${colors.NC}`);
      console.log('1. Run: claude-danger');
      console.log(`2. Copy and paste the contents of ${GENERATED_DIR}/claude_prompt.txt`);
      console.log('3. Work with Claude to refine the titles');
      console.log('4. Have Claude save the results to title_cards.json');
      console.log('5. Run: maketalk --continue');
    }
    } else {
      // Yakety not available - generate template
      await generateTemplateForManualEdit();
    }
  }
}

// Run the script
main().catch(error => {
  console.error(`${colors.RED}Error: ${error.message}${colors.NC}`);
  process.exit(1);
});