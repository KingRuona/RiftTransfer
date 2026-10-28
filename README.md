# RiftTransfer

RiftTransfer is a work-in-progress local wireless file transfer tool designed to make transferring files between computers and mobile devices easier over a local network.

## About

The project grew out of my experience moving files between my laptop and iPhone while working with video and digital content. I wanted to explore a way to transfer files locally without depending on cloud storage or mobile data.

## Built With

- Python
- FastAPI
- HTML
- CSS
- JavaScript

## Current Status

**Early MVP / Prototype — Work in Progress**

The project includes a web-based interface and a Python backend. File transfers between a PC and an iPhone have been tested.

Features and interface elements are still being developed, so this is not yet a finished release.

## Planned Improvements

- Device discovery and pairing
- QR-code pairing
- Transfer progress and speed indicators
- Batch and folder transfers
- Improved handling of large files
- User interface refinements

## Running Locally

1. Install Python.
2. Clone or download this repository.
3. Create and activate a virtual environment.
4. Install the dependencies:

   ```bash
   pip install -r requirements.txt
   ```

5. Start the application:

   ```bash
   python main.py
   ```

6. Open `http://127.0.0.1:8765` in your browser.

The application may use a different port if configured accordingly.

## Security Note

Keep local secrets, databases, received files, and environment-specific configuration out of version control. Use the application on trusted networks until its security and network-access behavior have been fully reviewed.

## Author

An ongoing personal software project exploring backend development, networking concepts, and practical file-transfer workflows.
