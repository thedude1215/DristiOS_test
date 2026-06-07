def fibonacci(limit):
    a, b = 0, 1
    while a <= limit:
        if a >= 1:
            print(a)
        a, b = b, a + b

print("Fibonacci series from 1 to 25:")
fibonacci(25)
