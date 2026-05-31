"""
Backward-compatible exports — implementation lives in hls_clipper.py (clean-room).
"""

from .hls_clipper import is_hls_url, smart_clip_hls

__all__ = ['is_hls_url', 'smart_clip_hls']
