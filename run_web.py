#!/usr/bin/env python3
# run_web.py
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from web.app import app

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000, threaded=True)
