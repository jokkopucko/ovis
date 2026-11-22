
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard};

pub struct LineSplitter {
    limit: usize,
    partial: Vec<u8>,
    skipping: bool,
}

impl LineSplitter {
    pub fn new(limit: usize) -> Self {
        Self { limit, partial: Vec::new(), skipping: false }
    }

    pub fn feed(&mut self, mut chunk: &[u8], mut frame: impl FnMut(&[u8])) -> usize {
        let mut dropped = 0;
        while let Some(end) = chunk.iter().position(|&byte| byte == b'\n') {
            let line = &chunk[..end];
            if self.skipping {
                self.skipping = false;
            } else if self.partial.is_empty() {
                if line.len() <= self.limit {
                    frame(line);
                } else {
                    dropped += 1;
                }
            } else if self.partial.len() + line.len() <= self.limit {
                self.partial.extend_from_slice(line);
                frame(&self.partial);
                // a frame can be 17 MiB: its memory goes with it
                self.partial = Vec::new();
            } else {
                self.partial = Vec::new();
                dropped += 1;
            }
            chunk = &chunk[end + 1..];
        }
        if !self.skipping && !chunk.is_empty() {
            if self.partial.len() + chunk.len() <= self.limit {
                self.partial.extend_from_slice(chunk);
            } else {
                self.partial = Vec::new();
                self.skipping = true;
                dropped += 1;
            }
        }
        dropped
    }
}

/// What a queued frame costs on top of its bytes: its slot in the queue, twice over since the queue's buffer
/// doubles as it grows, and the smallest allocation glibc's malloc makes. Charged so that millions of tiny
/// frames cannot outgrow the limit their bytes alone stay under.
pub const FRAME_COST: usize = 2 * std::mem::size_of::<Vec<u8>>() + 32;

fn cost(capacity: usize) -> usize {
    capacity + FRAME_COST
}

struct Queued {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
    overflowing: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Pushed {
    Queued,
    Empty,
    FirstOverflow,
    StillOverflowing,
}

pub struct InputQueue {
    limit: usize,
    queued: Mutex<Queued>,
    arrived: Condvar,
}

impl InputQueue {
    pub fn new(limit: usize) -> Self {
        Self { limit, queued: Mutex::new(Queued { frames: VecDeque::new(), bytes: 0, overflowing: false }), arrived: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Queued> {
        self.queued.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn push(&self, data: Vec<u8>) -> Pushed {
        if data.is_empty() {
            return Pushed::Empty;
        }
        let cost = cost(data.capacity());
        let mut queued = self.lock();
        if queued.bytes > 0 && queued.bytes + cost > self.limit {
            let first = !queued.overflowing;
            queued.overflowing = true;
            return if first { Pushed::FirstOverflow } else { Pushed::StillOverflowing };
        }
        queued.bytes += cost;
        queued.frames.push_back(data);
        self.arrived.notify_one();
        Pushed::Queued
    }

    pub fn next(&self) -> Vec<u8> {
        let mut queued = self.lock();
        loop {
            if let Some(data) = queued.frames.pop_front() {
                return data;
            }
            queued = self.arrived.wait(queued).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    pub fn written(&self, data: Vec<u8>) {
        let cost = cost(data.capacity());
        drop(data);
        let mut queued = self.lock();
        queued.bytes = queued.bytes.saturating_sub(cost);
        if queued.bytes <= self.limit / 2 {
            queued.overflowing = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(splitter: &mut LineSplitter, chunk: &[u8]) -> (Vec<Vec<u8>>, usize) {
        let mut frames = Vec::new();
        let dropped = splitter.feed(chunk, |frame| frames.push(frame.to_vec()));
        (frames, dropped)
    }

    #[test]
    fn joins_a_frame_split_across_reads() {
        let mut splitter = LineSplitter::new(16);
        assert_eq!(split(&mut splitter, b"{\"t\":"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"\"w\"}\nab"), (vec![b"{\"t\":\"w\"}".to_vec()], 0));
        assert_eq!(split(&mut splitter, b"c\n\n"), (vec![b"abc".to_vec(), b"".to_vec()], 0));
    }

    #[test]
    fn keeps_a_frame_of_exactly_the_limit() {
        let mut splitter = LineSplitter::new(4);
        assert_eq!(split(&mut splitter, b"ab"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"cd\nwxyz\n"), (vec![b"abcd".to_vec(), b"wxyz".to_vec()], 0));
    }

    #[test]
    fn discards_an_unfinished_frame_past_the_limit_up_to_its_newline() {
        let mut splitter = LineSplitter::new(4);
        assert_eq!(split(&mut splitter, b"abc"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"defgh"), (vec![], 1));
        assert_eq!(split(&mut splitter, b"ijklmnop"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"qr\nok\n"), (vec![b"ok".to_vec()], 0));
    }

    #[test]
    fn discards_a_whole_frame_past_the_limit_in_one_read() {
        let mut splitter = LineSplitter::new(4);
        assert_eq!(split(&mut splitter, b"abcdef\nok\n"), (vec![b"ok".to_vec()], 1));
        assert_eq!(split(&mut splitter, b"ab"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"cde\nok\n"), (vec![b"ok".to_vec()], 1));
    }

    #[test]
    fn takes_a_frame_into_an_empty_queue_whatever_its_size() {
        let queue = InputQueue::new(4);
        assert_eq!(queue.push(vec![0; 10]), Pushed::Queued);
        assert_eq!(queue.push(vec![0; 1]), Pushed::FirstOverflow);
    }

    #[test]
    fn refuses_input_past_the_limit_until_the_command_takes_some() {
        let queue = InputQueue::new(2 * (3 + FRAME_COST));
        assert_eq!(queue.push(vec![1; 3]), Pushed::Queued);
        assert_eq!(queue.push(vec![2; 3]), Pushed::Queued);
        assert_eq!(queue.push(vec![3; 1]), Pushed::FirstOverflow);
        let first = queue.next();
        assert_eq!(first, vec![1; 3]);
        assert_eq!(queue.push(vec![3; 1]), Pushed::StillOverflowing);
        queue.written(first);
        assert_eq!(queue.push(vec![3; 3]), Pushed::Queued);
        assert_eq!(queue.next(), vec![2; 3]);
        assert_eq!(queue.next(), vec![3; 3]);
    }

    #[test]
    fn charges_each_frame_its_cost_so_tiny_frames_stop_well_before_their_bytes_reach_the_limit() {
        let queue = InputQueue::new(10 * (1 + FRAME_COST));
        let taken = (0..10_000).take_while(|_| queue.push(vec![b'a']) == Pushed::Queued).count();
        assert_eq!(taken, 10);
    }

    #[test]
    fn charges_what_a_frame_holds_beyond_its_length() {
        let queue = InputQueue::new(2 * (64 + FRAME_COST));
        let mut roomy = Vec::with_capacity(64);
        roomy.push(b'a');
        assert_eq!(queue.push(roomy), Pushed::Queued);
        assert_eq!(queue.push(vec![b'b'; 64]), Pushed::Queued);
        assert_eq!(queue.push(vec![b'c']), Pushed::FirstOverflow);
    }

    #[test]
    fn calls_an_overflow_new_only_once_the_queue_drained_to_half_its_limit() {
        let queue = InputQueue::new(4 * (1 + FRAME_COST));
        for _ in 0..4 {
            assert_eq!(queue.push(vec![b'a']), Pushed::Queued);
        }
        assert_eq!(queue.push(vec![b'b']), Pushed::FirstOverflow);
        assert_eq!(queue.push(vec![b'b']), Pushed::StillOverflowing);
        queue.written(queue.next());
        assert_eq!(queue.push(vec![b'c']), Pushed::Queued);
        assert_eq!(queue.push(vec![b'c']), Pushed::StillOverflowing);
        queue.written(queue.next());
        queue.written(queue.next());
        assert_eq!(queue.push(vec![b'd']), Pushed::Queued);
        assert_eq!(queue.push(vec![b'd']), Pushed::Queued);
        assert_eq!(queue.push(vec![b'e']), Pushed::FirstOverflow);
    }

    #[test]
    fn queues_nothing_for_an_empty_frame() {
        let queue = InputQueue::new(1 + FRAME_COST);
        assert_eq!(queue.push(vec![b'a']), Pushed::Queued);
        for _ in 0..10_000 {
            assert_eq!(queue.push(Vec::new()), Pushed::Empty);
        }
        let first = queue.next();
        assert_eq!(first, vec![b'a']);
        queue.written(first);
        assert_eq!(queue.push(vec![b'b']), Pushed::Queued);
        assert_eq!(queue.next(), vec![b'b']);
    }
}
