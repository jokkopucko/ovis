/*
 * QR Code generator, ported from Project Nayuki's TypeScript implementation.
 * Copyright (c) Project Nayuki. (MIT License)
 * https://github.com/nayuki/QR-Code-generator
 * Permission and warranty terms are in THIRD_PARTY_NOTICES.md.
 */
using System;
using System.Collections.Generic;
using System.Text;

namespace Ovis
{
    internal static class QrCode
    {
        private const int ByteModeIndicator = 0b0100;
        private static readonly int[] LevelMEccLength = {
            -1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,
            26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28 };
        private static readonly int[] LevelMBlockCount = {
            -1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,
            17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49 };

        public static bool[,] Encode(string text)
        {
            if (text == null) throw new ArgumentNullException(nameof(text));
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            int version;
            for (version = 1; version <= 40; version++)
                if (bytes.Length < (1 << (version < 10 ? 8 : 16)) &&
                    4L + (version < 10 ? 8 : 16) + bytes.Length * 8L <= Capacity(version) * 8)
                    break;
            if (version > 40) throw new ArgumentException("Text exceeds QR Code level M capacity.", nameof(text));
            int capacity = Capacity(version) * 8;
            var bits = new List<bool>(capacity);
            Append(bits, ByteModeIndicator, 4);
            Append(bits, bytes.Length, version < 10 ? 8 : 16);
            foreach (byte b in bytes) Append(bits, b, 8);
            Append(bits, 0, Math.Min(4, capacity - bits.Count));
            Append(bits, 0, (8 - bits.Count % 8) % 8);
            for (int pad = 0xEC; bits.Count < capacity; pad ^= 0xEC ^ 0x11)
                Append(bits, pad, 8);
            var data = new byte[capacity / 8];
            for (int i = 0; i < bits.Count; i++)
                if (bits[i]) data[i >> 3] |= (byte)(1 << (7 - (i & 7)));
            return new Symbol(version, data).Modules;
        }

#if !QR_NO_DRAWING
        public static System.Drawing.Bitmap ToBitmap(bool[,] modules, int scale, int border)
        {
            if (modules == null) throw new ArgumentNullException(nameof(modules));
            if (scale <= 0) throw new ArgumentOutOfRangeException(nameof(scale));
            if (border < 0) throw new ArgumentOutOfRangeException(nameof(border));
            int height = modules.GetLength(0), width = modules.GetLength(1);
            var bitmap = new System.Drawing.Bitmap(
                checked((width + border * 2) * scale), checked((height + border * 2) * scale));
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
            {
                graphics.Clear(System.Drawing.Color.White);
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                for (int y = 0; y < height; y++)
                    for (int x = 0; x < width; x++)
                        if (modules[y, x])
                            graphics.FillRectangle(System.Drawing.Brushes.Black,
                                (x + border) * scale, (y + border) * scale, scale, scale);
            }
            return bitmap;
        }
#endif

        private static void Append(List<bool> bits, int value, int count)
        {
            for (int i = count - 1; i >= 0; i--) bits.Add(Bit(value, i));
        }

        private static bool Bit(int value, int index) { return ((value >> index) & 1) != 0; }

        private static int RawModules(int version)
        {
            int result = (16 * version + 128) * version + 64;
            if (version >= 2)
            {
                int align = version / 7 + 2;
                result -= (25 * align - 10) * align - 55;
                if (version >= 7) result -= 36;
            }
            return result;
        }

        private static int Capacity(int version)
        {
            return RawModules(version) / 8 - LevelMEccLength[version] * LevelMBlockCount[version];
        }

        private static byte Multiply(int x, int y)
        {
            int z = 0;
            for (int i = 7; i >= 0; i--)
            {
                z = (z << 1) ^ ((z >> 7) * 0x11D);
                z ^= ((y >> i) & 1) * x;
            }
            return (byte)z;
        }

        private static byte[] Interleave(int version, byte[] data)
        {
            int count = LevelMBlockCount[version], degree = LevelMEccLength[version];
            int raw = RawModules(version) / 8, shortCount = count - raw % count;
            int shortLength = raw / count;
            var divisor = new byte[degree];
            divisor[degree - 1] = 1;
            int root = 1;
            for (int i = 0; i < degree; i++)
            {
                for (int j = 0; j < degree; j++)
                {
                    divisor[j] = Multiply(divisor[j], root);
                    if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
                }
                root = Multiply(root, 2);
            }
            var blocks = new byte[count][];
            for (int b = 0, offset = 0; b < count; b++)
            {
                int length = shortLength - degree + (b < shortCount ? 0 : 1);
                var remainder = new byte[degree];
                blocks[b] = new byte[shortLength + 1];
                Array.Copy(data, offset, blocks[b], 0, length);
                for (int i = 0; i < length; i++)
                {
                    int factor = data[offset + i] ^ remainder[0];
                    Array.Copy(remainder, 1, remainder, 0, degree - 1);
                    remainder[degree - 1] = 0;
                    for (int j = 0; j < degree; j++)
                        remainder[j] ^= Multiply(divisor[j], factor);
                }
                offset += length;
                Array.Copy(remainder, 0, blocks[b], shortLength + 1 - degree, degree);
            }
            var result = new byte[raw];
            for (int i = 0, k = 0; i < shortLength + 1; i++)
                for (int b = 0; b < count; b++)
                    if (i != shortLength - degree || b >= shortCount)
                        result[k++] = blocks[b][i];
            return result;
        }

        private sealed class Symbol
        {
            internal readonly bool[,] Modules;
            private readonly bool[,] function;
            private readonly int size;

            internal Symbol(int version, byte[] data)
            {
                size = version * 4 + 17;
                Modules = new bool[size, size];
                function = new bool[size, size];
                for (int i = 0; i < size; i++)
                {
                    Set(6, i, i % 2 == 0);
                    Set(i, 6, i % 2 == 0);
                }
                Finder(3, 3);
                Finder(size - 4, 3);
                Finder(3, size - 4);
                if (version >= 2)
                {
                    int count = version / 7 + 2;
                    int step = (version * 8 + count * 3 + 5) / (count * 4 - 4) * 2;
                    var positions = new int[count];
                    positions[0] = 6;
                    for (int i = count - 1, pos = size - 7; i >= 1; i--, pos -= step)
                        positions[i] = pos;
                    for (int i = 0; i < count; i++)
                        for (int j = 0; j < count; j++)
                            if (!(i == 0 && j == 0 || i == 0 && j == count - 1 || i == count - 1 && j == 0))
                                for (int dy = -2; dy <= 2; dy++)
                                    for (int dx = -2; dx <= 2; dx++)
                                        Set(positions[i] + dx, positions[j] + dy,
                                            Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
                }
                Format(0);
                if (version >= 7)
                {
                    int rem = version;
                    for (int i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
                    int bits = version << 12 | rem;
                    for (int i = 0; i < 18; i++)
                    {
                        int a = size - 11 + i % 3, b = i / 3;
                        Set(a, b, Bit(bits, i));
                        Set(b, a, Bit(bits, i));
                    }
                }
                byte[] codewords = Interleave(version, data);
                int index = 0;
                for (int right = size - 1; right >= 1; right -= 2)
                {
                    if (right == 6) right = 5;
                    for (int vert = 0; vert < size; vert++)
                        for (int j = 0; j < 2; j++)
                        {
                            int x = right - j, y = ((right + 1) & 2) == 0 ? size - 1 - vert : vert;
                            if (!function[y, x] && index < codewords.Length * 8)
                            {
                                Modules[y, x] = Bit(codewords[index >> 3], 7 - (index & 7));
                                index++;
                            }
                        }
                }
                int bestMask = 0, minimum = int.MaxValue;
                for (int mask = 0; mask < 8; mask++)
                {
                    Mask(mask);
                    Format(mask);
                    int penalty = Penalty();
                    if (penalty < minimum) { minimum = penalty; bestMask = mask; }
                    Mask(mask);
                }
                Mask(bestMask);
                Format(bestMask);
            }

            private void Set(int x, int y, bool dark)
            {
                Modules[y, x] = dark;
                function[y, x] = true;
            }

            private void Finder(int x, int y)
            {
                for (int dy = -4; dy <= 4; dy++)
                    for (int dx = -4; dx <= 4; dx++)
                    {
                        int xx = x + dx, yy = y + dy, dist = Math.Max(Math.Abs(dx), Math.Abs(dy));
                        if (xx >= 0 && xx < size && yy >= 0 && yy < size)
                            Set(xx, yy, dist != 2 && dist != 4);
                    }
            }

            private void Format(int mask)
            {
                // Level M's two format bits are zero.
                int rem = mask;
                for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
                int bits = (mask << 10 | rem) ^ 0x5412;
                for (int i = 0; i <= 5; i++) Set(8, i, Bit(bits, i));
                Set(8, 7, Bit(bits, 6));
                Set(8, 8, Bit(bits, 7));
                Set(7, 8, Bit(bits, 8));
                for (int i = 9; i < 15; i++) Set(14 - i, 8, Bit(bits, i));
                for (int i = 0; i < 8; i++) Set(size - 1 - i, 8, Bit(bits, i));
                for (int i = 8; i < 15; i++) Set(8, size - 15 + i, Bit(bits, i));
                Set(8, size - 8, true);
            }

            private void Mask(int mask)
            {
                for (int y = 0; y < size; y++)
                    for (int x = 0; x < size; x++)
                    {
                        bool invert;
                        switch (mask)
                        {
                            case 0: invert = (x + y) % 2 == 0; break;
                            case 1: invert = y % 2 == 0; break;
                            case 2: invert = x % 3 == 0; break;
                            case 3: invert = (x + y) % 3 == 0; break;
                            case 4: invert = (x / 3 + y / 2) % 2 == 0; break;
                            case 5: invert = x * y % 2 + x * y % 3 == 0; break;
                            case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
                            case 7: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
                            default: throw new ArgumentOutOfRangeException(nameof(mask));
                        }
                        if (!function[y, x] && invert) Modules[y, x] = !Modules[y, x];
                    }
            }

            private int Penalty()
            {
                int result = 0, dark = 0;
                // N1 and N3: same-color runs and 1:1:3:1:1 finder-like runs.
                for (int axis = 0; axis < 2; axis++)
                    for (int line = 0; line < size; line++)
                    {
                        bool color = false;
                        int run = 0;
                        var history = new int[7];
                        for (int p = 0; p < size; p++)
                        {
                            bool current = axis == 0 ? Modules[line, p] : Modules[p, line];
                            if (current == color)
                            {
                                run++;
                                if (run == 5) result += 3;
                                else if (run > 5) result++;
                            }
                            else
                            {
                                AddHistory(run, history);
                                if (!color) result += CountPatterns(history) * 40;
                                color = current;
                                run = 1;
                            }
                        }
                        if (color) { AddHistory(run, history); run = 0; }
                        AddHistory(run + size, history);
                        result += CountPatterns(history) * 40;
                    }
                for (int y = 0; y < size; y++)
                    for (int x = 0; x < size; x++)
                    {
                        bool color = Modules[y, x];
                        if (color) dark++;
                        // N2: monochrome 2x2 blocks.
                        if (x + 1 < size && y + 1 < size && color == Modules[y, x + 1] &&
                            color == Modules[y + 1, x] && color == Modules[y + 1, x + 1])
                            result += 3;
                    }
                int total = size * size;
                return result + ((Math.Abs(dark * 20 - total * 10) + total - 1) / total - 1) * 10;
            }

            private void AddHistory(int run, int[] history)
            {
                // Treat the outside as a light border.
                if (history[0] == 0) run += size;
                Array.Copy(history, 0, history, 1, history.Length - 1);
                history[0] = run;
            }

            private static int CountPatterns(int[] h)
            {
                int n = h[1];
                bool core = n > 0 && h[2] == n && h[3] == n * 3 && h[4] == n && h[5] == n;
                return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) +
                    (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
            }
        }
    }
}
