def fibonacci(n):
    fib_series = []
    a, b = 0, 1
    for _ in range(n):
        fib_series.append(a)
        a, b = b, a + b
    return fib_series

# Generate first 10 Fibonacci numbers
n = 10
result = fibonacci(n)
print(f"Fibonacci series (first {n} numbers):")
print(result)
